import awsLambdaFastify from "@fastify/aws-lambda";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";

import { buildApplication } from "../app.js";
import { loadEnvironment } from "../config/env.js";
import { loadSecureParameters } from "../config/parameterStore.js";

type Proxy = awsLambdaFastify.PromiseHandler<APIGatewayProxyEventV2>;

let proxy: Proxy | undefined;

async function getProxy(): Promise<Proxy> {
  if (proxy) return proxy;
  await loadSecureParameters("api");
  // The Lambda adapter sets the socket address from API Gateway's trusted
  // requestContext.http.sourceIp. Do not let forwarded headers override it.
  const { app } = await buildApplication({ ...loadEnvironment(), TRUST_PROXY: false });
  proxy = awsLambdaFastify<APIGatewayProxyEventV2>(app, { decorateRequest: false });
  return proxy;
}

export async function handler(event: APIGatewayProxyEventV2, context: Context) {
  context.callbackWaitsForEmptyEventLoop = false;
  return (await getProxy())(event, context);
}
