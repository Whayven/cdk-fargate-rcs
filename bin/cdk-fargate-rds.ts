#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CdkFargateRdsStack } from '../lib/cdk-fargate-rds-stack';

const app = new cdk.App();
new CdkFargateRdsStack(app, 'CdkFargateRdsStack', {
    stackName: 'FargateRdsStack',
    env: {
        region: process.env.CDK_DEFAULT_REGION,
        account: process.env.CDK_DEFAULT_ACCOUNT,
    },
});