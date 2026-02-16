import * as cdk from 'aws-cdk-lib'
import {InfrastructureStack} from "./InfrastructureStack";
import {ServerDeployStack} from "./ServerDeployStack";
import {UIDeployStack} from "./UIDeployStack";

const app = new cdk.App()

const infra = new InfrastructureStack(app, 'InfrastructureStack', {
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
    }
})

new ServerDeployStack(app, 'ServerDeployStack', {
    ec2Role: infra.ec2Role,
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
    }
});

new UIDeployStack(app, 'UIDeployStack', {
    ec2Role: infra.ec2Role,
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
    }
});