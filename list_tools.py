import asyncio
import json
import os

from mcp import ClientSession
from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client


async def main():
    async with aws_iam_streamablehttp_client(
        endpoint=os.environ["GATEWAY_URL"],
        aws_region="us-east-1",
        aws_service="bedrock-agentcore",
    ) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            for tool in tools.tools:
                print(tool.name)
                print("  ", json.dumps(tool.inputSchema, ensure_ascii=False))
                print("  ", tool.description)


asyncio.run(main())
