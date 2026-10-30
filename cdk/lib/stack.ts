import { readFileSync } from "node:fs";
import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

const definition = (file: string) =>
  sfn.DefinitionBody.fromString(readFileSync(new URL(`../sfn/${file}`, import.meta.url), "utf-8"));

export class SfnGatewayToolsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 店長に承認依頼をメールで送る
    const topic = new sns.Topic(this, "ApprovalTopic");
    topic.addSubscription(new subscriptions.EmailSubscription(this.node.getContext("email")));

    // 承認ページのパスワード（Basic認証）
    const password = new secretsmanager.Secret(this, "ApprovalPassword", {
      generateSecretString: { passwordLength: 24, excludePunctuation: true },
    });

    // メールのリンクから承認・却下を受け付ける
    const approval = new lambda.Function(this, "ApprovalFunction", {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: "approval.handler",
      code: lambda.Code.fromAsset(new URL("../lambda", import.meta.url).pathname),
      environment: { PASSWORD_SECRET_ARN: password.secretArn },
    });
    password.grantRead(approval);
    approval.addToRolePolicy(new iam.PolicyStatement({
      actions: ["states:SendTaskSuccess"],
      resources: ["*"], // タスクトークンの操作はリソースを指定できない
    }));
    const approvalUrl = approval.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // 在庫テーブルと検証用の在庫データ
    const stockTable = new dynamodb.TableV2(this, "StockTable", {
      tableName: "sfn-gateway-tools-stock",
      partitionKey: { name: "item", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const stocks = [
      { item: "牛乳", stock: 3, unitPrice: 180, dailySales: 40 },
      { item: "卵", stock: 25, unitPrice: 240, dailySales: 30 },
      { item: "米5kg", stock: 2, unitPrice: 2980, dailySales: 8 },
    ];
    new cr.AwsCustomResource(this, "SeedStocks", {
      onCreate: {
        service: "DynamoDB",
        action: "batchWriteItem",
        parameters: {
          RequestItems: {
            "sfn-gateway-tools-stock": stocks.map((stock) => ({
              PutRequest: {
                Item: {
                  item: { S: stock.item },
                  stock: { N: String(stock.stock) },
                  unitPrice: { N: String(stock.unitPrice) },
                  dailySales: { N: String(stock.dailySales) },
                },
              },
            })),
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of("seed-stocks"),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [stockTable.tableArn] }),
      installLatestAwsSdk: false,
    }).node.addDependency(stockTable);

    // 発注（Standard）と在庫照会（Express）のステートマシン
    const order = new sfn.StateMachine(this, "PurchaseOrderWorkflow", {
      stateMachineName: "PurchaseOrderWorkflow",
      definitionBody: definition("purchase-order.asl.json"),
      definitionSubstitutions: { TOPIC_ARN: topic.topicArn, APPROVAL_URL: approvalUrl.url },
    });
    topic.grantPublish(order);
    const stock = new sfn.StateMachine(this, "StockLookupExpress", {
      stateMachineName: "StockLookupExpress",
      definitionBody: definition("stock-lookup.asl.json"),
      definitionSubstitutions: { TABLE_NAME: stockTable.tableName },
      stateMachineType: sfn.StateMachineType.EXPRESS,
    });
    stockTable.grantReadData(stock);

    // IAM認証のGateway（サービスロールはCDKが作る）
    const policyEngine = new agentcore.PolicyEngine(this, "PolicyEngine", {
      policyEngineName: "sfn_tools_policy_engine",
    });
    const gateway = new agentcore.Gateway(this, "Gateway", {
      gatewayName: "sfn-tools-gateway",
      authorizerConfiguration: agentcore.GatewayAuthorizer.usingAwsIam(),
      policyEngineConfiguration: { policyEngine, mode: agentcore.PolicyEngineMode.ENFORCE },
    });
    // サービスロールの権限を公開するステートマシンと実行に絞る
    const executionArn = cdk.Arn.format(
      { service: "states", resource: "execution", resourceName: `${order.stateMachineName}:*`, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME },
      this,
    );
    gateway.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["states:StartExecution", "states:StartSyncExecution", "states:ListExecutions", "states:DescribeStateMachine"],
      resources: [order.stateMachineArn, stock.stateMachineArn],
    }));
    gateway.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["states:DescribeExecution", "states:GetExecutionHistory", "states:StopExecution"],
      resources: [executionArn],
    }));

    // Step Functionsのコネクタターゲット（L2がないのでL1で書く）
    const connectorTarget = (name: string, configurations: agentcore.CfnGatewayTarget.ConnectorConfigurationProperty[]) =>
      new agentcore.CfnGatewayTarget(this, `${name}Target`, {
        gatewayIdentifier: gateway.gatewayId,
        name,
        targetConfiguration: {
          mcp: { connector: { source: { connectorId: "states" }, configurations } },
        },
        credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      });

    const orderTarget = connectorTarget("order", [
      { name: "StartExecution", parameterValues: { stateMachineArn: order.stateMachineArn } },
      { name: "ListExecutions", parameterValues: { stateMachineArn: order.stateMachineArn } },
      { name: "DescribeStateMachine", parameterValues: { stateMachineArn: order.stateMachineArn } },
      { name: "DescribeExecution" },
      { name: "GetExecutionHistory" },
      { name: "StopExecution" },
    ]);
    connectorTarget("stock", [
      { name: "StartSyncExecution", parameterValues: { stateMachineArn: stock.stateMachineArn } },
    ]);

    // 店長のロール（発注の取り消しは店長だけに許可する）
    const managerRole = new iam.Role(this, "ManagerRole", {
      roleName: "sfn-gateway-tools-manager",
      assumedBy: new iam.AccountRootPrincipal(),
    });
    gateway.grantInvoke(managerRole);

    // Cedarのポリシー
    const gatewayEntity = `AgentCore::Gateway::"${gateway.gatewayArn}"`;
    const cedar = (id: string, statement: string, ignoreFindings = false) =>
      new agentcore.Policy(this, id, {
        policyEngine,
        statement: agentcore.PolicyStatement.fromCedar(statement),
        validationMode: ignoreFindings ? agentcore.PolicyValidationMode.IGNORE_ALL_FINDINGS : undefined,
      });
    // Cedarはデフォルト拒否なので、このGatewayのツールをIAMの呼び出し元に許可しておく
    cedar("AllowGatewayTools", `permit(principal is AgentCore::IamEntity, action, resource == ${gatewayEntity});`, true);
    // 発注の取り消しは店長のロールだけ（ポリシーはツールと突き合わせて検証されるので、ターゲットの後に作る）
    cedar("OnlyManagerCanStop", `forbid(principal is AgentCore::IamEntity, action == AgentCore::Action::"order___StopExecution", resource == ${gatewayEntity})
      unless { principal.id like "*sfn-gateway-tools-manager*" };`).node.addDependency(orderTarget);

    new cdk.CfnOutput(this, "ManagerRoleArn", { value: managerRole.roleArn });
    new cdk.CfnOutput(this, "GatewayUrl", { value: gateway.gatewayUrl! });
    new cdk.CfnOutput(this, "StockArn", { value: stock.stateMachineArn });
    new cdk.CfnOutput(this, "PasswordSecretArn", { value: password.secretArn });
  }
}
