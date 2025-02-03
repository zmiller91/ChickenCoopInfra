import * as cdk from "aws-cdk-lib";
import {Construct} from "constructs";
import {
    aws_codebuild,
    aws_codedeploy,
    aws_codepipeline,
    aws_codepipeline_actions,
    aws_iam,
    StackProps
} from "aws-cdk-lib";
import {ComputeType, LinuxBuildImage} from "aws-cdk-lib/aws-codebuild";
import {CodeBuildActionType} from "aws-cdk-lib/aws-codepipeline-actions";
import {Pipeline, PipelineType} from "aws-cdk-lib/aws-codepipeline";


export interface UIDeployStackProps extends StackProps {
    ec2Role: aws_iam.Role
}

export class UIDeployStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: UIDeployStackProps) {
        super(scope, id, props);



        // Create the build pipeline for deploying code
        const buildProject = new aws_codebuild.Project(this, "UICodeBuild", {
            environment: {
                buildImage: LinuxBuildImage.STANDARD_7_0,
                computeType: ComputeType.SMALL
            },
            buildSpec: aws_codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    build: {
                        commands: [
                            'npm run build'
                        ]
                    }
                },
                artifacts: {
                    files: [
                        'build/**/*',
                        'appspec.yml',
                        'scripts/aws/*.sh'
                    ],
                    'discard-paths': 'no'
                }
            })
        })

        const sourceOutput = new aws_codepipeline.Artifact();
        const sourceAction = new aws_codepipeline_actions.GitHubSourceAction({
            actionName: "DownloadCode",
            owner: "zmiller91",
            repo: "CoopUI",
            oauthToken: cdk.SecretValue.secretsManager('GitHubAccessToken'),
            branch: "master",
            output: sourceOutput
        })

        const buildOutput = new aws_codepipeline.Artifact();
        const build = new aws_codepipeline_actions.CodeBuildAction({
            actionName: "BuildCode",
            input: sourceOutput,
            outputs: [buildOutput],
            type: CodeBuildActionType.BUILD,
            project: buildProject
        })

        const codeDeployApp = new aws_codedeploy.ServerApplication(this, "CoopUICodeDeployApp", {
                applicationName: "CoopUI",
            }
        )

        const codeDeployRole = new aws_iam.Role(this, 'CoopUICodeDeployRole', {
            assumedBy: new aws_iam.ServicePrincipal('codedeploy.amazonaws.com'),
        });

        const codeDeployGroup = new aws_codedeploy.ServerDeploymentGroup(this, 'CoopUICodeDeployGroup', {
            application: codeDeployApp,
            role:codeDeployRole,
            deploymentGroupName: "CoopUICodeDeployGroup",
            installAgent: true,
            ec2InstanceTags: new aws_codedeploy.InstanceTagSet({
                "CodeDeploy": ["ChickenCoop"]
            }),
        })

        const deploy = new aws_codepipeline_actions.CodeDeployServerDeployAction({
            actionName: "DeployCode",
            input: buildOutput,
            deploymentGroup: codeDeployGroup
        })

        // The GitHubAccessToken needs to be created manually since it relies on obtaining an oauth token from github
        const codePipeline = new Pipeline(this, "CoopUIServerPipeline", {
            pipelineName: "CoopUIBuildPipeline",
            pipelineType: PipelineType.V2,
            stages: [
                {
                    stageName: "DownloadCode",
                    actions: [sourceAction]
                },
                {
                    stageName: "BuildCode",
                    actions: [build]
                },
                {
                    stageName: "DeployCode",
                    actions: [deploy]
                }
            ]
        })

        const ec2Role = props.ec2Role;

        ec2Role.addToPolicy(new aws_iam.PolicyStatement({
            actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
            resources: [codePipeline.artifactBucket.bucketArn,
                codePipeline.artifactBucket.bucketArn + "/*"]
        }));

        ec2Role.addToPolicy(new aws_iam.PolicyStatement({
            actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "s3:GetQueueAttributes"],
            resources: ["*"]
        }));

        ec2Role.addToPolicy(new aws_iam.PolicyStatement({
            actions: [
                "iot:Connect",
                "iot:Publish",
                "iot:Subscribe",
                "iot:Receive",
                "iot:GetThingShadow",
                "iot:UpdateThingShadow",
                "iot:DeleteThingShadow",
                "iot:ListNamedShadowsForThing"
            ],
            resources: ["*"]
        }));

        ec2Role.addToPolicy(new aws_iam.PolicyStatement({
            actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "s3:GetQueueAttributes"],
            resources: [codePipeline.artifactBucket.bucketArn,
                codePipeline.artifactBucket.bucketArn + "/*"]
        }));

        if(codePipeline.artifactBucket.encryptionKey) {
            ec2Role.addToPolicy(new aws_iam.PolicyStatement({
                actions: ["kms:Decrypt"],
                resources: [codePipeline.artifactBucket.encryptionKey.keyArn]
            }))
        }




    }
}