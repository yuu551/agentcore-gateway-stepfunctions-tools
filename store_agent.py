import sys

from strands import Agent
from strands.hooks import BeforeToolCallEvent

from gateway_tools import escape_non_ascii, gateway_client

SYSTEM_PROMPT = """あなたはスーパーの発注担当です。
- 在庫は stock___StartSyncExecution に {"item": "商品名"} を渡して確認します
- 発注は order___StartExecution に {"item": "商品名", "quantity": 発注数, "unitPrice": 単価, "reason": "発注理由"} を渡して開始します
- 発注を開始したら order___DescribeExecution で結果を確認します
"""

agent = Agent(
    model="us.anthropic.claude-haiku-5-5",
    tools=[gateway_client(r"^(stock|order)___")],
    system_prompt=SYSTEM_PROMPT,
)
agent.hooks.add_callback(BeforeToolCallEvent, escape_non_ascii)
agent(sys.argv[1])
