import { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda'
import 'source-map-support/register'
import * as AWS from 'aws-sdk'
import * as crypto from 'crypto'
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
const parameterStoreName = {
  githubAccessToken: 'github_access_token',
  githubWebhookSecret: 'github_webhook_secret'
}
let githubAccessToken = ''
let githubWebhookSecret = ''

const getParametersWithCache = async () => {
  if (!githubWebhookSecret) {
    const { Parameter } = await ssm
      .getParameter({ Name: parameterStoreName.githubWebhookSecret, WithDecryption: true })
      .promise()
    githubWebhookSecret = (Parameter && Parameter.Value) || ''
  }
  if (!githubAccessToken) {
    const { Parameter } = await ssm
      .getParameter({ Name: parameterStoreName.githubWebhookSecret, WithDecryption: true })
      .promise()
    githubAccessToken = (Parameter && Parameter.Value) || ''
  }
}

export const webhook: APIGatewayProxyHandler = async (event, _context) => {
  await getParametersWithCache()

  if (!event.body || !bucketName) {
    console.error('[Validation] Failed: Webhook payload or environment variables are missing.')
    return proxyResult
  }

  const payload = JSON.parse(event.body) as PushEventPayload // Unsafe
  const ref = payload['ref']
  const repoName = payload['repository']['name']
  const archiveUrl = payload['repository']['archive_url']
  const url = archiveUrl.replace('{archive_format}', 'zipball').replace('{/ref}', ref)

  if (!ref.includes('tags')) {
    console.log('[Validation] Skipped: This push event has no tags.')
    return proxyResult
  }

  if (!githubWebhookSecret) {
    console.error('[Validation] Error: GitHub webhook secret is missing.')
    return proxyResult
  }

  const signatureBuffer = Buffer.from(event.headers['X-Hub-Signature'])
  const signedBuffer = Buffer.from(
    'sha1' +
      crypto
        .createHmac('sha1', githubWebhookSecret)
        .update(event.body)
        .digest('hex')
  )
  const verified = crypto.timingSafeEqual(signatureBuffer, signedBuffer)
  if (!verified) {
    console.error('[Validation] Error: GitHub webhook secret is invalid.')
    return proxyResult
  }

  if (!githubAccessToken) {
    console.error('[Validation] Failed: GitHub Access Token is missing')
    return proxyResult
  }

  const config: AxiosRequestConfig = {
    headers: { Authorization: `token ${githubAccessToken}` },
    responseType: 'arraybuffer'
  }
  const { status, data } = await axios.get<Buffer>(url, config)
  console.log(`[Download zip file] StatusCode: ${status}`)
  if (status !== 200) {
    return proxyResult
  }

  const fileName = `${repoName}.zip`
  const { Bucket, Key } = await s3.upload({ Bucket: bucketName, Key: fileName, Body: data }).promise()
  console.log(`[Upload zip to S3] Succeeded: Bucket '${Bucket}', Key '${Key}'`)

  return proxyResult
}
