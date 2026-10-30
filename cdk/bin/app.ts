import * as cdk from "aws-cdk-lib";
import { SfnGatewayToolsStack } from "../lib/stack.ts";

const app = new cdk.App();
new SfnGatewayToolsStack(app, "SfnGatewayToolsStack", {
  env: { region: "us-east-1" },
});
