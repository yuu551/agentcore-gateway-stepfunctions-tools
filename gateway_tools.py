import json
import os
import re

from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client
from strands.hooks import BeforeToolCallEvent
from strands.tools.mcp import MCPClient


def gateway_client(pattern: str) -> MCPClient:
    # Gatewayのツールのうち、名前がpatternに合うものだけをエージェントに渡す
    return MCPClient(
        lambda: aws_iam_streamablehttp_client(
            endpoint=os.environ["GATEWAY_URL"],
            aws_region="us-east-1",
            aws_service="bedrock-agentcore",
        ),
        tool_filters={"allowed": [re.compile(pattern)]},
    )


def escape_non_ascii(event: BeforeToolCallEvent):
    args = event.tool_use["input"]
    print(f"\n[{event.tool_use['name']}] {json.dumps(args, ensure_ascii=False)}")
    # ワークフローに渡すJSONの日本語を \uXXXX 形式にしてから送る
    if isinstance(args.get("input"), str):
        args["input"] = json.dumps(json.loads(args["input"]))
