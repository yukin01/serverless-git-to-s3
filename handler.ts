import { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda'
import 'source-map-support/register'
import * as AWS from 'aws-sdk'
import axios, { AxiosRequestConfig } from 'axios'

const s3 = new AWS.S3()
const ssm = new AWS.SSM()

type PushEventPayload = {
  ref: string
  repository: {
    name: string
    archive_url: string
  }
}

const proxyResult: APIGatewayProxyResult = { statusCode: 200, body: 'exit' }
const bucketName = process.env.BUCKET_NAME
const githubTokenParameterName = "github_access_token"
let githubToken: string | null = null

export const webhook: APIGatewayProxyHandler = async (event, _context) => {
  if (!event.body || !bucketName) {
    console.error(`[Validation] Failed: Webhook payload or environment variables are missing.`)
    return proxyResult
  }

  const payload = JSON.parse(event.body) as PushEventPayload // Unsafe
  const ref = payload["ref"]
  const repoName = payload["repository"]["name"]
  const archiveUrl = payload["repository"]["archive_url"]
  const url = archiveUrl.replace("{archive_format}", "zipball").replace('{/ref}', ref)

  if (!githubToken) {
    const { Parameter } = await ssm.getParameter({ Name: githubTokenParameterName }).promise()
    githubToken = Parameter && Parameter.Value || null
  }

  if (!githubToken) {
    console.error(`[Validation] Failed: GitHub Access Token is missing`)
    return proxyResult
  }
  
  const config: AxiosRequestConfig = { 
    headers: { Authorization: `token ${githubToken}` },
    responseType: 'arraybuffer'
  }
  const { status, data } = await axios.get<Buffer>(url, config)
  console.log(`[Download zip file] StatusCode: ${status}`)
  if (status !== 200) { return proxyResult }

  const fileName = `${repoName}.zip`
  const { Bucket, Key } = await s3.upload({ Bucket: bucketName, Key: fileName, Body: data }).promise()
  console.log(`[Upload zip to S3] Succeeded: Bucket '${Bucket}', Key '${Key}'`)
  
  return proxyResult
}
