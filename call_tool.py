import asyncio
import json
import os
import sys

from mcp import ClientSession
from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client


async def main(name: str, arguments: dict):
    async with aws_iam_streamablehttp_client(
        endpoint=os.environ["GATEWAY_URL"],
        aws_region="us-east-1",
        aws_service="bedrock-agentcore",
    ) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(name, arguments)
            print("isError:", result.isError)
            for c in result.content:
                print(c.text)


asyncio.run(main(sys.argv[1], json.loads(sys.argv[2])))
