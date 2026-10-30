# AgentCore Gateway で Step Functions のワークフローを AI エージェントのツールにするサンプル

Amazon Bedrock AgentCore Gateway の Step Functions コネクタを使い、スーパーの発注業務を題材にしたワークフローを Strands Agents から呼び出すサンプルです。

- 在庫照会ワークフロー（Express）を `StartSyncExecution` で呼び出し、DynamoDB の在庫テーブルを `GetItem` で読む
- 発注ワークフロー（Standard）を `StartExecution` で開始し、`DescribeExecution`・`GetExecutionHistory` で状況を確認する
- 合計が3万円を超える発注は、SNS で店長にメールを送って承認を待つ（`.waitForTaskToken`）
- 店長がメールのリンクから承認すると、Lambda が `SendTaskSuccess` でワークフローを再開させる（承認ページは Basic 認証、承認待ちは24時間で期限切れ）
- Gateway に Policy Engine（Cedar）を付け、発注の取り消し（`order___StopExecution`）を店長のロール `sfn-gateway-tools-manager` だけに許可する

> [!WARNING]
> 検証用のサンプルです。承認ページ（Lambda 関数 URL）には簡易的な Basic 認証しか付けていないので、本番では使わないでください。検証が終わったら `cdk destroy` で削除してください。

## 構成

| パス | 内容 |
| --- | --- |
| `cdk/` | DynamoDB・SNS・承認用 Lambda・ステートマシン・Gateway・ターゲット・Cedar のポリシーを作る CDK アプリ |
| `cdk/sfn/` | ステートマシンの定義（JSONata） |
| `cdk/lambda/approval.py` | 承認ページと `SendTaskSuccess` の呼び出し |
| `gateway_tools.py` | Gateway への接続と、入力の日本語をエスケープするフック |
| `store_agent.py` | 発注担当のエージェント |
| `list_tools.py` / `call_tool.py` | ツール一覧の取得と、ツールを1つ呼び出す確認用スクリプト |

## 必要なもの

- Node.js 26 と pnpm 12（`mise install` で `mise.toml` の版が入ります）
- Python 3.15 と uv
- us-east-1 で Amazon Bedrock の Claude Haiku 5.5 を使える AWS 認証情報
- CDK のブートストラップ済みの環境

## 使い方

```bash
# AWS のリソースを作る
cd cdk
pnpm install
pnpm exec cdk deploy -c email=<店長のメールアドレス> --outputs-file outputs.json
cd ..
jq -r '.SfnGatewayToolsStack | "GATEWAY_URL=\(.GatewayUrl)\nSTOCK_ARN=\(.StockArn)"' cdk/outputs.json > .env
```

デプロイ後に届く「Subscription Confirmation」のメールで Confirm subscription を押します。承認ページのパスワードは次のコマンドで取得できます（ユーザー名は任意）。

```bash
aws secretsmanager get-secret-value --secret-id "$(jq -r .SfnGatewayToolsStack.PasswordSecretArn cdk/outputs.json)" \
  --query SecretString --output text
```

```bash
# エージェントを動かす
uv sync
set -a; source .env; set +a
uv run store_agent.py "牛乳の在庫が少ないので、明日の分を発注しておいて"
uv run store_agent.py "米5kgが残りわずかなので、1週間分を発注して"
```

2つ目の発注は承認待ちになり、店長にメールが届きます。メールのリンクから「承認する」を押すとワークフローが再開します。

## 後片付け

```bash
cd cdk
pnpm exec cdk destroy -c email=<店長のメールアドレス>
```
