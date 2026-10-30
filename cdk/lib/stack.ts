import { readFileSync } from "node:fs";
import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import { Construct } from "constructs";

const definition = (file: string) =>
  sfn.DefinitionBody.fromString(readFileSync(new URL(`../sfn/${file}`, import.meta.url), "utf-8"));

export class SfnGatewayToolsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 店長に承認依頼をメールで送る
    const topic = new sns.Topic(this, "ApprovalTopic");
    topic.addSubscription(new subscriptions.EmailSubscription(this.node.getContext("email")));

    // メールのリンクから承認・却下を受け付ける
    const approval = new lambda.Function(this, "ApprovalFunction", {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: "approval.handler",
      code: lambda.Code.fromAsset(new URL("../lambda", import.meta.url).pathname),
    });
    approval.addToRolePolicy(new iam.PolicyStatement({
      actions: ["states:SendTaskSuccess"],
      resources: ["*"], // タスクトークンの操作はリソースを指定できない
    }));
    const approvalUrl = approval.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

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
      stateMachineType: sfn.StateMachineType.EXPRESS,
    });

    // IAM認証のGateway（サービスロールはCDKが作る）
    const gateway = new agentcore.Gateway(this, "Gateway", {
      gatewayName: "sfn-tools-gateway",
      authorizerConfiguration: agentcore.GatewayAuthorizer.usingAwsIam(),
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

    connectorTarget("order", [
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

    new cdk.CfnOutput(this, "GatewayUrl", { value: gateway.gatewayUrl! });
    new cdk.CfnOutput(this, "StockArn", { value: stock.stateMachineArn });
  }
}
