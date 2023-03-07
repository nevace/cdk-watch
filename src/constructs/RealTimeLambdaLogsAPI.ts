/* eslint-disable no-new */
import * as path from 'path';
import {NestedStack, Stack, RemovalPolicy, Duration} from 'aws-cdk-lib';
import {AttributeType, BillingMode, Table} from 'aws-cdk-lib/aws-dynamodb';
import {
  Effect,
  ManagedPolicy,
  PolicyStatement,
  ServicePrincipal,
  Role,
} from 'aws-cdk-lib/aws-iam';
import {
  CfnApi,
  CfnDeployment,
  CfnIntegration,
  CfnRoute,
  CfnStage,
} from 'aws-cdk-lib/aws-apigatewayv2';
import {
  Code,
  Runtime,
  Function as LambdaFunction,
} from 'aws-cdk-lib/aws-lambda';
import {RetentionDays} from 'aws-cdk-lib/aws-logs';
import {Construct, DependencyGroup} from 'constructs';
import {LogsLayerVersion} from './LogsLayerVersion';

export class RealTimeLambdaLogsAPI extends NestedStack {
  public readonly connectFn: LambdaFunction;

  public readonly disconnectFn: LambdaFunction;

  public readonly defaultFn: LambdaFunction;

  /** role needed to send messages to websocket clients */
  public readonly apigwRole: Role;

  public readonly CDK_WATCH_CONNECTION_TABLE_NAME: string;

  public readonly CDK_WATCH_API_GATEWAY_MANAGEMENT_URL: string;

  private connectionTable: Table;

  public executeApigwPolicy: PolicyStatement;

  public logsLayerVersion: LogsLayerVersion;

  public websocketApi: CfnApi;

  public lambdaDynamoConnectionPolicy: PolicyStatement;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const stack = Stack.of(this);
    const routeSelectionKey = 'action';
    // NOTE: This file will be bundled into /lib/index.js, so this path must be relative to that
    const websocketHandlerCodePath = path.join(__dirname, 'websocketHandlers');

    this.logsLayerVersion = new LogsLayerVersion(this, 'LogsLayerVersion');

    // table where websocket connections will be stored
    const websocketTable = new Table(this, 'connections', {
      partitionKey: {
        name: 'connectionId',
        type: AttributeType.STRING,
      },
      billingMode: BillingMode.PROVISIONED,
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
      writeCapacity: 5,
      readCapacity: 5,
    });

    this.websocketApi = new CfnApi(this, 'LogsWebsocketApi', {
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: `$request.body.${routeSelectionKey}`,
      name: `${id}LogsWebsocketApi`,
    });

    const basePermissions = websocketTable.tableArn;
    const indexPermissions = `${basePermissions}/index/*`;
    this.lambdaDynamoConnectionPolicy = new PolicyStatement({
      actions: ['dynamodb:*'],
      resources: [basePermissions, indexPermissions],
    });

    const connectLambdaRole = new Role(this, 'connect-lambda-role', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    connectLambdaRole.addToPolicy(this.lambdaDynamoConnectionPolicy);
    connectLambdaRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName(
        'service-role/AWSLambdaBasicExecutionRole',
      ),
    );

    const disconnectLambdaRole = new Role(this, 'disconnect-lambda-role', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    disconnectLambdaRole.addToPolicy(this.lambdaDynamoConnectionPolicy);
    disconnectLambdaRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName(
        'service-role/AWSLambdaBasicExecutionRole',
      ),
    );

    const messageLambdaRole = new Role(this, 'message-lambda-role', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    messageLambdaRole.addToPolicy(this.lambdaDynamoConnectionPolicy);
    messageLambdaRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName(
        'service-role/AWSLambdaBasicExecutionRole',
      ),
    );

    const resourceStr = this.createResourceStr(
      stack.account,
      stack.region,
      this.websocketApi.ref,
    );

    this.executeApigwPolicy = new PolicyStatement({
      actions: ['execute-api:Invoke', 'execute-api:ManageConnections'],
      resources: [resourceStr],
      effect: Effect.ALLOW,
    });

    const lambdaProps = {
      code: Code.fromAsset(websocketHandlerCodePath),
      timeout: Duration.seconds(300),
      runtime: Runtime.NODEJS_18_X,
      logRetention: RetentionDays.FIVE_DAYS,
      role: disconnectLambdaRole,
      environment: {
        CDK_WATCH_CONNECTION_TABLE_NAME: websocketTable.tableName,
      },
    };

    const connectLambda = new LambdaFunction(this, 'ConnectLambda', {
      handler: 'index.onConnect',
      description: 'Connect a user.',
      ...lambdaProps,
    });

    const disconnectLambda = new LambdaFunction(this, 'DisconnectLambda', {
      handler: 'index.onDisconnect',
      description: 'Disconnect a user.',
      ...lambdaProps,
    });

    const defaultLambda = new LambdaFunction(this, 'DefaultLambda', {
      handler: 'index.onMessage',
      description: 'Default',
      ...lambdaProps,
    });

    // access role for the socket api to access the socket lambda
    const policy = new PolicyStatement({
      effect: Effect.ALLOW,
      resources: [
        connectLambda.functionArn,
        disconnectLambda.functionArn,
        defaultLambda.functionArn,
      ],
      actions: ['lambda:InvokeFunction'],
    });

    const role = new Role(this, `LogsWebsocketIamRole`, {
      assumedBy: new ServicePrincipal('apigateway.amazonaws.com'),
    });
    role.addToPolicy(policy);

    // websocket api lambda integration
    const connectIntegration = new CfnIntegration(
      this,
      'connect-lambda-integration',
      {
        apiId: this.websocketApi.ref,
        integrationType: 'AWS_PROXY',
        integrationUri: this.createIntegrationStr(
          stack.region,
          connectLambda.functionArn,
        ),
        credentialsArn: role.roleArn,
      },
    );

    const disconnectIntegration = new CfnIntegration(
      this,
      'disconnect-lambda-integration',
      {
        apiId: this.websocketApi.ref,
        integrationType: 'AWS_PROXY',
        integrationUri: this.createIntegrationStr(
          stack.region,
          disconnectLambda.functionArn,
        ),
        credentialsArn: role.roleArn,
      },
    );

    const defaultIntegration = new CfnIntegration(
      this,
      'default-lambda-integration',
      {
        apiId: this.websocketApi.ref,
        integrationType: 'AWS_PROXY',
        integrationUri: this.createIntegrationStr(
          stack.region,
          defaultLambda.functionArn,
        ),
        credentialsArn: role.roleArn,
      },
    );

    // Example route definition
    const connectRoute = new CfnRoute(this, 'connect-route', {
      apiId: this.websocketApi.ref,
      routeKey: '$connect',
      authorizationType: 'AWS_IAM',
      target: `integrations/${connectIntegration.ref}`,
    });

    const disconnectRoute = new CfnRoute(this, 'disconnect-route', {
      apiId: this.websocketApi.ref,
      routeKey: '$disconnect',
      authorizationType: 'NONE',
      target: `integrations/${disconnectIntegration.ref}`,
    });

    const defaultRoute = new CfnRoute(this, 'default-route', {
      apiId: this.websocketApi.ref,
      routeKey: '$default',
      authorizationType: 'NONE',
      target: `integrations/${defaultIntegration.ref}`,
    });

    // allow other other tables to grant permissions to these lambdas
    this.connectFn = connectLambda;
    this.disconnectFn = disconnectLambda;
    this.defaultFn = defaultLambda;
    this.connectionTable = websocketTable;
    this.apigwRole = messageLambdaRole;

    // deployment
    const apigwWssDeployment = new CfnDeployment(this, 'apigw-deployment', {
      apiId: this.websocketApi.ref,
    });

    // stage
    const apiStage = new CfnStage(this, 'apigw-stage', {
      apiId: this.websocketApi.ref,
      autoDeploy: true,
      deploymentId: apigwWssDeployment.ref,
      stageName: 'v1',
      defaultRouteSettings: {
        throttlingBurstLimit: 500,
        throttlingRateLimit: 1000,
      },
    });

    // all routes are dependencies of the deployment
    const routes = new DependencyGroup([
      connectRoute,
      disconnectRoute,
      defaultRoute,
    ]);

    // add the dependency
    apigwWssDeployment.node.addDependency(routes);

    this.CDK_WATCH_CONNECTION_TABLE_NAME = websocketTable.tableName;
    this.CDK_WATCH_API_GATEWAY_MANAGEMENT_URL = this.createConnectionString(
      apiStage.stageName,
      stack.region,
      this.websocketApi.ref,
    );
  }

  private createIntegrationStr = (region: string, fnArn: string): string =>
    `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${fnArn}/invocations`;

  private createConnectionString = (
    route: string,
    region: string,
    ref: string,
  ) => `https://${ref}.execute-api.${region}.amazonaws.com/${route}`;

  private createResourceStr = (
    accountId: string,
    region: string,
    ref: string,
  ): string => `arn:aws:execute-api:${region}:${accountId}:${ref}/*`;

  public grantReadWrite = (lambdaFunction: LambdaFunction): void => {
    this.connectionTable.grantReadWriteData(lambdaFunction);
  };
}
