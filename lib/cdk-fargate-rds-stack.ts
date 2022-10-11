import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import {Vpc, SubnetType, InstanceType, InstanceClass, Port, InstanceSize} from "aws-cdk-lib/aws-ec2";
import {DatabaseInstance, PostgresEngineVersion, DatabaseInstanceEngine, Credentials} from "aws-cdk-lib/aws-rds";
import {DnsValidatedCertificate} from "aws-cdk-lib/aws-certificatemanager";
import {Bucket} from 'aws-cdk-lib/aws-s3';
import {HostedZone} from 'aws-cdk-lib/aws-route53';
import {ApplicationLoadBalancedFargateService} from "aws-cdk-lib/aws-ecs-patterns";
import {Cluster, ContainerImage, FargateTaskDefinition, LogDriver, Secret} from "aws-cdk-lib/aws-ecs";

import path = require('path');

export class CdkFargateRdsStack extends cdk.Stack {
    constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const databaseName = 'dbName';
        const databaseUsername = 'dbUser';

        // Create VPC with public and private subnet
        const vpc = new Vpc(this, 'vpc', {
            cidr: '10.0.0.0/16',
            natGateways: 0,
            maxAzs: 2,
            subnetConfiguration: [
                {
                    name: 'public',
                    subnetType: SubnetType.PUBLIC,
                    cidrMask: 24,
                },
                {
                    name: 'isolated',
                    subnetType: SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 28,
                },
            ],
        });

        // Create user for handling media upload to s3
        const group = new iam.Group(this, 'group-id', {
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'),
            ],
        });

        const user = new iam.User(this, 'user', {
            groups: [group],
        });

        const accessKey = new iam.AccessKey(this, 'AccessKey', {user});

        // create s3 bucket for media storage
        const bucket = new Bucket(this, 'bucket', {
            // bucketName: 'cloudway',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            publicReadAccess: true,
            enforceSSL: true,
        });

        bucket.addToResourcePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [new iam.AnyPrincipal()],
                actions: ['s3:GetObject', 's3:ListBucket'],
                resources: [`${bucket.bucketArn}`, `${bucket.bucketArn}/*`],
            }),
        );

        // create RDS instance
        const dbInstance = new DatabaseInstance(this, 'postgres-db', {
            vpc,
            vpcSubnets: {
                subnetType: SubnetType.PRIVATE_ISOLATED,
            },
            engine: DatabaseInstanceEngine.postgres({
                version: PostgresEngineVersion.VER_14,
            }),
            instanceType: InstanceType.of(
                InstanceClass.BURSTABLE3,
                InstanceSize.MICRO,
            ),
            credentials: Credentials.fromGeneratedSecret(databaseUsername),
            multiAz: false,
            allocatedStorage: 100,
            maxAllocatedStorage: 105,
            allowMajorVersionUpgrade: false,
            autoMinorVersionUpgrade: true,
            backupRetention: cdk.Duration.days(0),
            deleteAutomatedBackups: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            deletionProtection: false,
            databaseName,
            publiclyAccessible: false,
        });

        if (!dbInstance.secret) {
            throw new Error('No Secret on RDS database');
        }

        const hostedZone = HostedZone.fromLookup(this, 'Zone', {
            domainName: 'example.com',
        });

        // full domain/subdomain name
        const domainName = 'app.example.com';
        const certificate = new DnsValidatedCertificate(this, "SiteCertificate", {
            domainName,
            hostedZone,
            region: cdk.Aws.REGION,
        });

        const cluster = new Cluster(this, 'cluster', {vpc});

        const taskRole = new iam.Role(this, 'task', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'),
            ],
        });
        const taskDefinition = new FargateTaskDefinition(this, 'fargateTask', {
            cpu: 512,
            memoryLimitMiB: 2048,
            taskRole,
        });

        const strapiContainer = taskDefinition.addContainer('container', {
            // Upload docker image to ECR
            image: ContainerImage.fromAsset(
                path.resolve(__dirname, '..', 'app'),
                {
                    file: 'Dockerfile',
                },
            ),
            logging: LogDriver.awsLogs({streamPrefix: 'app-logs'}),
            secrets: {
                DATABASE_HOST: Secret.fromSecretsManager(dbInstance.secret, 'host'),
                DATABASE_USERNAME: Secret.fromSecretsManager(
                    dbInstance.secret,
                    'username',
                ),
                DATABASE_PASSWORD: Secret.fromSecretsManager(
                    dbInstance.secret,
                    'password',
                ),
                DATABASE_NAME: Secret.fromSecretsManager(
                    dbInstance.secret,
                    'dbname',
                ),
                DATABASE_PORT: Secret.fromSecretsManager(dbInstance.secret, 'port'),
            },
            environment: {
                AWS_BUCKET_NAME: bucket.bucketName,
                AWS_REGION: user.env.region,
                AWS_ACCESS_KEY_ID: accessKey.accessKeyId,
                AWS_SECRET_KEY: accessKey.secretAccessKey.toString(),
                NODE_ENV: 'development',
            },
        });
        strapiContainer.addPortMappings({
            containerPort: 1337,
        });

        const loadBalancedService =

            new ApplicationLoadBalancedFargateService(
                this,
                'backendFargate',
                {
                    cluster,
                    taskDefinition,
                    certificate,
                    domainName,
                    domainZone: hostedZone,
                    redirectHTTP: true,
                    assignPublicIp: true,
                },
            );

        dbInstance.connections.allowFrom(
            loadBalancedService.service,
            Port.tcp(5432),
        );
    }
}

