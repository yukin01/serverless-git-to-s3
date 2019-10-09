import { APIGatewayProxyHandler } from 'aws-lambda';
import 'source-map-support/register';
// import * as AWS from 'aws-sdk'

// const s3 = new AWS.S3()

export const webhook: APIGatewayProxyHandler = async (event, _context) => {
  const body = JSON.parse(event.body)
  console.log(JSON.stringify(body, null, 2))
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Go Serverless Webpack (Typescript) v1.0! Your function executed successfully!',
      input: event
    }, null, 2),
  };
}
