#!/usr/bin/env node
import "source-map-support/register.js";

import * as cdk from "aws-cdk-lib";

import { BudgetValidationStack } from "../lib/budget-validation-stack.js";

const app = new cdk.App();
new BudgetValidationStack(app, "BudgetValidationStack", {
  env: {
    ...(process.env.CDK_DEFAULT_ACCOUNT ? { account: process.env.CDK_DEFAULT_ACCOUNT } : {}),
    region: process.env.CDK_DEFAULT_REGION ?? "eu-central-1",
  },
  description: "Serverless budget validation API, scheduled workflow, state, SSM parameters, and monitoring",
});
