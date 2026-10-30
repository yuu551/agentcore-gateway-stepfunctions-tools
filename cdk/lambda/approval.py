import base64
import html
import json
from urllib.parse import parse_qs

import boto3

sfn = boto3.client("stepfunctions")

PAGE = """<!doctype html><meta charset="utf-8"><title>発注の承認</title>
<p>今回の検証用の簡素なページです。本番用ではありません。</p>
<form method="post"><input type="hidden" name="token" value="{token}">
<button name="action" value="approve">承認する</button>
<button name="action" value="reject">却下する</button></form>"""


def handler(event, context):
    # リンクを開いただけでは承認せず、ボタンが押されたら結果を返す
    if event["requestContext"]["http"]["method"] == "GET":
        token = event["queryStringParameters"]["token"]
        return page(PAGE.format(token=html.escape(token)))

    body = event.get("body", "")
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode()
    form = {k: v[0] for k, v in parse_qs(body).items()}
    approved = form["action"] == "approve"
    sfn.send_task_success(taskToken=form["token"], output=json.dumps({"approved": approved}))
    return page("<p>承認しました</p>" if approved else "<p>却下しました</p>")


def page(body):
    return {"statusCode": 200, "headers": {"Content-Type": "text/html; charset=utf-8"}, "body": body}
