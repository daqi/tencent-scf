const { Component } = require('@serverless/core')
const DeployFunction = require('./library/deployFunction')
const DeployTrigger = require('./library/deployTrigger')
const RemoveFunction = require('./library/removeFunction')
const TencentLogin = require('tencent-login')
const Provider = require('./library/provider')
const _ = require('lodash')
const fs = require('fs')
const util = require('util')
const path = require('path')
const utils = require('./library/utils')
const tencentcloud = require('tencentcloud-sdk-nodejs')
const ClientProfile = require('tencentcloud-sdk-nodejs/tencentcloud/common/profile/client_profile.js')
const HttpProfile = require('tencentcloud-sdk-nodejs/tencentcloud/common/profile/http_profile.js')
const AbstractModel = require('tencentcloud-sdk-nodejs/tencentcloud/common/abstract_model')
const AbstractClient = require('tencentcloud-sdk-nodejs/tencentcloud/common/abstract_client')

class GetUserAppIdResponse extends AbstractModel {
  constructor() {
    super()
    this.RequestId = null
  }

  deserialize(params) {
    if (!params) {
      return
    }
    this.AppId = 'RequestId' in params ? params.AppId : null
    this.RequestId = 'RequestId' in params ? params.RequestId : null
  }
}

class AppidClient extends AbstractClient {
  constructor(credential, region, profile) {
    super('cam.tencentcloudapi.com', '2019-01-16', credential, region, profile)
  }

  GetUserAppId(req, cb) {
    const resp = new GetUserAppIdResponse()
    this.request('GetUserAppId', req, resp, cb)
  }
}

class TencentCloudFunction extends Component {
  async getAppid(credentials) {
    const secret_id = credentials.SecretId
    const secret_key = credentials.SecretKey
    const cred = credentials.token
      ? new tencentcloud.common.Credential(secret_id, secret_key, credentials.token)
      : new tencentcloud.common.Credential(secret_id, secret_key)
    const httpProfile = new HttpProfile()
    httpProfile.reqTimeout = 30
    const clientProfile = new ClientProfile('HmacSHA256', httpProfile)
    const cam = new AppidClient(cred, 'ap-guangzhou', clientProfile)
    const req = new GetUserAppIdResponse()
    const body = {}
    req.from_json_string(JSON.stringify(body))
    const handler = util.promisify(cam.GetUserAppId.bind(cam))
    try {
      return handler(req)
    } catch (e) {
      throw 'Get Appid failed! '
    }
  }

  async doLogin() {
    const login = new TencentLogin()
    const tencent_credentials = await login.login()
    if (tencent_credentials) {
      tencent_credentials.timestamp = Date.now() / 1000
      try {
        const tencent = {
          SecretId: tencent_credentials.secret_id,
          SecretKey: tencent_credentials.secret_key,
          AppId: tencent_credentials.appid,
          token: tencent_credentials.token,
          expired: tencent_credentials.expired,
          signature: tencent_credentials.signature,
          uuid: tencent_credentials.uuid,
          timestamp: tencent_credentials.timestamp
        }
        await fs.writeFileSync('./.env_temp', JSON.stringify(tencent))
        return tencent
      } catch (e) {
        throw 'Error getting temporary key: ' + e
      }
    }
  }

  async sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }

  async getTempKey(temp) {
    const that = this

    if (temp) {
      while (true) {
        try {
          const tencent_credentials_read = JSON.parse(await fs.readFileSync('./.env_temp', 'utf8'))
          if (
            Date.now() / 1000 - tencent_credentials_read.timestamp <= 5 &&
            tencent_credentials_read.AppId
          ) {
            return tencent_credentials_read
          }
          await that.sleep(1000)
        } catch (e) {
          await that.sleep(1000)
        }
      }
    }

    try {
      const data = await fs.readFileSync('./.env_temp', 'utf8')
      try {
        const tencent = {}
        const tencent_credentials_read = JSON.parse(data)
        if (
          Date.now() / 1000 - tencent_credentials_read.timestamp <= 6000 &&
          tencent_credentials_read.AppId
        ) {
          return tencent_credentials_read
        }
        const login = new TencentLogin()
        const tencent_credentials_flush = await login.flush(
          tencent_credentials_read.uuid,
          tencent_credentials_read.expired,
          tencent_credentials_read.signature,
          tencent_credentials_read.AppId
        )
        if (tencent_credentials_flush) {
          tencent.SecretId = tencent_credentials_flush.secret_id
          tencent.SecretKey = tencent_credentials_flush.secret_key
          tencent.AppId = tencent_credentials_flush.appid
          tencent.token = tencent_credentials_flush.token
          tencent.expired = tencent_credentials_flush.expired
          tencent.signature = tencent_credentials_flush.signature
          tencent.uuid = tencent_credentials_read.uuid
          tencent.timestamp = Date.now() / 1000
          await fs.writeFileSync('./.env_temp', JSON.stringify(tencent))
          return tencent
        }
        return await that.doLogin()
      } catch (e) {
        return await that.doLogin()
      }
    } catch (e) {
      return await that.doLogin()
    }
  }

  async deploy(inputs = {}) {
    await this.debug('deploying')
    inputs.handler = 'index.handler'
    // login
    // const temp = this.context.instance.state.status
    // this.context.instance.state.status = true
    const { tencent } = this.credentials
    // if (!tencent) {
    //   tencent = await this.getTempKey(temp)
    //   this.context.credentials.tencent = tencent
    // }

    // get AppId

    if (!this.credentials.tencent.AppId) {
      const appId = await this.getAppid(tencent)
      this.credentials.tencent.AppId = appId.AppId
    }

    const provider = new Provider(inputs)
    const services = provider.getServiceResource()

    const option = {
      region: provider.region,
      timestamp: this.credentials.tencent.timestamp || null,
      token: this.credentials.tencent.token || null
    }
    const attr = {
      appid: tencent.AppId,
      secret_id: tencent.SecretId,
      secret_key: tencent.SecretKey,
      options: option,
      context: this
    }

    await this.debug('constructing')
    const func = new DeployFunction(attr)
    const trigger = new DeployTrigger(attr)

    await this.debug('adding role')
    // add role
    inputs.enableRoleAuth = inputs.enableRoleAuth
      ? true
      : inputs.enableRoleAuth == false
      ? false
      : true
    if (inputs.enableRoleAuth) {
      await func.addRole()
    }

    await this.debug('cleaning old functions')
    // clean old function
    const funcObject = _.cloneDeep(services.Resources.default[inputs.name])
    funcObject.FuncName = inputs.name
    if (this.state && this.state.deployed && this.state.deployed.Name) {
      if (this.state.deployed.Name != funcObject.FuncName) {
        try {
          const handler = new RemoveFunction(attr)
          await handler.remove(this.state.deployed.Name)
        } catch (e) {
          await this.debug('Remove old function failed.')
        }
      }
    }

    await this.debug('packing dir')

    fs.copyFileSync(
      path.join(__dirname, 'shims', 'binary-case.js'),
      path.join(inputs.src, 'binary-case.js')
    )
    fs.copyFileSync(path.join(__dirname, 'shims', 'index.js'), path.join(inputs.src, 'index.js'))
    fs.copyFileSync(
      path.join(__dirname, 'shims', 'media-typer.js'),
      path.join(inputs.src, 'media-typer.js')
    )
    fs.copyFileSync(
      path.join(__dirname, 'shims', 'middleware.js'),
      path.join(inputs.src, 'middleware.js')
    )
    fs.copyFileSync(
      path.join(__dirname, 'shims', 'mime-db.json'),
      path.join(inputs.src, 'mime-db.json')
    )
    fs.copyFileSync(
      path.join(__dirname, 'shims', 'mime-types.js'),
      path.join(inputs.src, 'mime-types.js')
    )
    fs.copyFileSync(
      path.join(__dirname, 'shims', 'type-is.js'),
      path.join(inputs.src, 'type-is.js')
    )

    // packDir
    const zipOutput = util.format('%s/%s.zip', '/tmp', inputs.name)
    await this.debug(`Compressing function ${funcObject.FuncName} file to ${zipOutput}.`)
    await utils.packDir(inputs.src, zipOutput, inputs.include, inputs.exclude)
    await this.debug(`Compressed function ${funcObject.FuncName} file successful`)

    // upload to cos
    const cosBucketName = funcObject.Properties.CodeUri.Bucket
    const cosBucketKey = funcObject.Properties.CodeUri.Key
    await this.debug(`Uploading service package to cos[${cosBucketName}]. ${cosBucketKey}`)
    await func.uploadPackage2Cos(cosBucketName, cosBucketKey, zipOutput)
    await this.debug(`Uploaded package successful ${zipOutput}`)

    // create function
    await this.debug(`Creating function ${funcObject.FuncName}`)
    const oldFunc = await func.deploy('default', funcObject)
    await this.debug(`Created function ${funcObject.FuncName} successful`)

    // set tags
    await this.debug(`Setting tags for function ${funcObject.FuncName}`)
    await func.createTags('default', funcObject.FuncName, funcObject.Properties.Tags)

    // deploy trigger
    // apigw: apigw component
    // cos/ckkafka/cmq/timer: cloud api/sdk
    await this.debug(`Creating trigger for function ${funcObject.FuncName}`)
    const apiTriggerList = new Array()
    const events = new Array()
    if (funcObject.Properties && funcObject.Properties.Events) {
      for (let i = 0; i < funcObject.Properties.Events.length; i++) {
        const keys = Object.keys(funcObject.Properties.Events[i])
        const thisTrigger = funcObject.Properties.Events[i][keys[0]]
        let tencentApiGateway
        if (thisTrigger.Type == 'APIGW') {
          tencentApiGateway = await this.load('tencentApig', thisTrigger.Properties.serviceName)
          const apigwOutput = await tencentApiGateway(thisTrigger.Properties)
          apiTriggerList.push(thisTrigger.Properties.serviceName + ' - ' + apigwOutput['subDomain'])
        } else {
          events.push(funcObject.Properties.Events[i])
        }
      }
      funcObject.Properties.Events = events
      await trigger.create(
        'default',
        oldFunc ? oldFunc.Triggers : null,
        funcObject,
        (response, thisTrigger) =>
          this.debug(
            `Created ${thisTrigger.Type} trigger ${response.TriggerName} for function ${funcObject.FuncName} success.`
          ),
        (error) => {
          throw error
        }
      )
    }

    await this.debug(`Deployed function ${funcObject.FuncName} successful`)

    const apigwParam = {
      apiName: inputs.apiName,
      serviceName: inputs.serviceName,
      description: 'Serverless Framework tencent-express Component',
      serviceId: inputs.serviceId,
      region: inputs.region,
      protocol:
        inputs.apigatewayConf && inputs.apigatewayConf.protocol
          ? inputs.apigatewayConf.protocol
          : 'http',
      environment:
        inputs.apigatewayConf && inputs.apigatewayConf.environment
          ? inputs.apigatewayConf.environment
          : 'release',
      endpoints: [
        {
          path: '/',
          method: 'ANY',
          function: {
            isIntegratedResponse: true,
            functionName: funcObject.FuncName
          }
        }
      ]
    }

    await this.debug(`loading apig`)
    const apig = this.load('tencentApig', 'apig')

    await this.debug(`deploying apig`)
    const tencentApiGatewayOutputs = await apig.deploy(apigwParam)

    const outputs = {
      url: `${tencentApiGatewayOutputs.protocol}://${tencentApiGatewayOutputs.subDomain}/${tencentApiGatewayOutputs.environment}/`
    }

    return outputs
  }

  async remove() {
    // login
    const temp = this.context.instance.state.status
    this.context.instance.state.status = true
    let { tencent } = this.context.credentials
    if (!tencent) {
      tencent = await this.getTempKey(temp)
      this.context.credentials.tencent = tencent
    }

    // get AppId
    if (!this.context.credentials.tencent.AppId) {
      const appId = await this.getAppid(tencent)
      this.context.credentials.tencent.AppId = appId.AppId
    }

    this.context.status(`Removing`)

    if (_.isEmpty(this.state.deployed)) {
      this.context.debug(`Aborting removal. Function name not found in state.`)
      return
    }

    const funcObject = this.state.deployed

    const option = {
      region: funcObject.Region,
      token: this.context.credentials.tencent.token || null
    }

    const attr = {
      appid: tencent.AppId,
      secret_id: tencent.SecretId,
      secret_key: tencent.SecretKey,
      options: option,
      context: this.context
    }
    const handler = new RemoveFunction(attr)

    let tencentApiGateway
    for (let i = 0; i < funcObject.APIGateway.length; i++) {
      try {
        const arr = funcObject.APIGateway[i].toString().split(' - ')
        tencentApiGateway = await this.load('@serverless/tencent-apigateway', arr[0])
        await tencentApiGateway.remove()
      } catch (e) {}
    }

    await handler.remove(funcObject.Name)
    this.context.debug(`Removed function ${funcObject.Name} successful`)

    this.state = {}
    await this.save()
    return funcObject
  }
}

module.exports = TencentCloudFunction
