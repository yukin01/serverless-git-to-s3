import { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda'
import 'source-map-support/register'
import * as AWS from 'aws-sdk'
import * as crypto from 'crypto'
import axios, { AxiosRequestConfig } from 'axios'
import * as JSZip from 'jszip'

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
      .getParameter({ Name: parameterStoreName.githubAccessToken, WithDecryption: true })
      .promise()
    githubAccessToken = (Parameter && Parameter.Value) || ''
  }
}

export const webhook: APIGatewayProxyHandler = async (event, _context) => {
  await getParametersWithCache()

  if (!event.body || !bucketName) {
    console.error('[Validation] Error: Webhook payload or environment variables are missing.')
    return proxyResult
  }

  const payload = JSON.parse(event.body) as PushEventPayload // Unsafe
  const ref = payload['ref']
  const repoName = payload['repository']['name']
  const archiveUrl = payload['repository']['archive_url']

  // Extract only tag push event
  console.log(`[Validation] Log: ref '${ref}'`)
  if (!ref.includes('tags')) {
    console.log('[Validation] Skipped: This push event has no tags.')
    return proxyResult
  }

  // Verify github webhook secret
  if (!githubWebhookSecret) {
    console.error('[Validation] Error: GitHub webhook secret is missing.')
    return proxyResult
  }
  const signatureBuffer = Buffer.from(event.headers['X-Hub-Signature'])
  const signedBuffer = Buffer.from(
    'sha1=' +
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

  // Download source zip from archive link
  if (!githubAccessToken) {
    console.error('[Validation] Error: GitHub Access Token is missing.')
    return proxyResult
  }
  const url = archiveUrl.replace('{archive_format}', 'zipball').replace('{/ref}', ref)
  const config: AxiosRequestConfig = {
    headers: { Authorization: `token ${githubAccessToken}` },
    responseType: 'arraybuffer'
  }
  const { status, data } = await axios.get<Buffer>(url, config)
  console.log(`[Download zip file] Log: status code ${status}`)
  if (status !== 200) {
    return proxyResult
  }

  // Remove root directory
  const zip = await JSZip.loadAsync(data)
  const files = zip.files  
  const newZip = new JSZip()
  const promises = Object.keys(files)
    .filter(key => !files[key].dir)
    .map(async key => {
      const file = files[key]
      const buffer = await file.async('nodebuffer')
      const path = file.name
        .split('/')
        .slice(1)
        .join('/')
      newZip.file(path, buffer)
    })
  await Promise.all(promises)
  const newBuffer = await newZip.generateAsync({ type: 'nodebuffer' })

  // Upload zip to S3
  const uploadFileName = `${repoName}.zip`
  const { Bucket, Key } = await s3.upload({ Bucket: bucketName, Key: uploadFileName, Body: newBuffer }).promise()
  console.log(`[Upload zip to S3] Success: Bucket '${Bucket}', Key '${Key}'`)

  return proxyResult
}
