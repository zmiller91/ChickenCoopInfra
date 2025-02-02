import * as cdk from 'aws-cdk-lib'
import {CodeDeployPipeline} from "./CodeDeployPipeline";

const app = new cdk.App()
new CodeDeployPipeline(app, 'CodeDeployPipelineStack', {})