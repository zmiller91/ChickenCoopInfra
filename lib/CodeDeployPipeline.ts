import * as cdk from "aws-cdk-lib";
import {
    aws_certificatemanager, aws_cloudfront, aws_cloudfront_origins,
    aws_codebuild,
    aws_codedeploy,
    aws_codepipeline,
    aws_codepipeline_actions,
    aws_ec2,
    aws_iam,
    aws_rds,
    Tags
} from "aws-cdk-lib";
import {Construct} from "constructs";
import {IpAddresses} from "aws-cdk-lib/aws-ec2";
import * as fs from "node:fs";
import {Pipeline, PipelineType} from "aws-cdk-lib/aws-codepipeline";
import {CodeBuildActionType} from "aws-cdk-lib/aws-codepipeline-actions";
import {ComputeType, LinuxBuildImage} from "aws-cdk-lib/aws-codebuild";

export class CodeDeployPipeline extends cdk.Stack{
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Create the VPC for the application
        const vpc = new aws_ec2.Vpc(this, "ChickenCoopVPC", {
            ipAddresses: IpAddresses.cidr("10.0.1.0/20"),
            maxAzs: 2,
            subnetConfiguration: [
                {
                    cidrMask: 25,
                    name: 'public',
                    subnetType: aws_ec2.SubnetType.PUBLIC
                },
                {
                    cidrMask: 25,
                    name: 'private',
                    subnetType: aws_ec2.SubnetType.PRIVATE_WITH_EGRESS
                }
            ]
        });

        // Create the database, allowing TCP access on the DB port for all IPs within the VPC
        const dbSecurityGroup = new aws_ec2.SecurityGroup(this, "DBSecurityGroup", {
            vpc: vpc
        })

        const database = new aws_rds.DatabaseInstance(this, "MysqlInstance", {
            credentials: aws_rds.Credentials.fromUsername("ChickenCoopProd"),
            engine: aws_rds.DatabaseInstanceEngine.MYSQL,
            vpc: vpc,
            instanceType: aws_ec2.InstanceType.of(aws_ec2.InstanceClass.BURSTABLE3, aws_ec2.InstanceSize.MICRO),
            multiAz: false,
            allocatedStorage: 20,
            maxAllocatedStorage: 20,
            securityGroups: [dbSecurityGroup]
        });

        dbSecurityGroup.addIngressRule(aws_ec2.Peer.ipv4(vpc.vpcCidrBlock), aws_ec2.Port.tcp(3306))


        // Creat the EC2 image that hosts the app, assign it a public IP, and allow ssh access
        const ec2Role = new aws_iam.Role(this, 'ChickenCoopEc2CodeDeployRole', {
           assumedBy: new aws_iam.ServicePrincipal('ec2.amazonaws.com'),
        });

        const instanceProfile = new aws_iam.InstanceProfile(this, 'ChickenCoopInstanceProfile', {
            role: ec2Role,
            instanceProfileName: "ChickenCoopInstanceProfile",
        })

        const codeDeployScript = fs.readFileSync('scripts/code-deploy-agent.sh', 'utf8')

        const userData = aws_ec2.UserData.forLinux();
        userData.addCommands(
            'yes y | sudo yum install java-17-amazon-corretto-headless',
            'yes y | sudo dnf install mariadb105',
            'yes y | sudo yum install certbot-apache',
            'sudo ln -s /snap/bin/certbot /usr/bin/certbot',
            'certbot-3 ',
            'sudo certbot-3 certonly --standalone --non-interactive --agree-tos --email \'me@zackmiller.info\' --domains api.pisprout.com',
            'sudo openssl pkcs12 -export -in /etc/letsencrypt/live/api.pisprout.com/fullchain.pem -inkey /etc/letsencrypt/live/api.pisprout.com/privkey.pem -out apipisprout.pfx -password pass:password',
            codeDeployScript,
        )

        const ec2SecurityGroup = new aws_ec2.SecurityGroup(this, "EC2SecurityGroup", {
            vpc: vpc
        })

        const ec2Instance = new aws_ec2.Instance(this, "ChickenCoopEc2Instance", {
            instanceType: new aws_ec2.InstanceType("t4g.small"),
            vpc: vpc,
            machineImage: new aws_ec2.AmazonLinuxImage({
                cpuType: aws_ec2.AmazonLinuxCpuType.ARM_64,
                generation: aws_ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023
            }),
            instanceProfile: instanceProfile,
            associatePublicIpAddress: true,
            vpcSubnets: {subnets: vpc.publicSubnets},
            securityGroup: ec2SecurityGroup,
            userData: userData,
        });

        Tags.of(ec2Instance).add("CodeDeploy", "ChickenCoop");
        ec2SecurityGroup.addIngressRule(aws_ec2.Peer.anyIpv4(), aws_ec2.Port.SSH)
        ec2SecurityGroup.addIngressRule(aws_ec2.Peer.anyIpv4(), aws_ec2.Port.HTTP)
        ec2SecurityGroup.addIngressRule(aws_ec2.Peer.anyIpv4(), aws_ec2.Port.HTTPS)
        ec2SecurityGroup.connections.allowFrom(dbSecurityGroup, aws_ec2.Port.allTcp())

        // Create the build pipeline for deploying code
        const buildProject = new aws_codebuild.Project(this, "CodeBuild", {
            environment: {
                buildImage: LinuxBuildImage.STANDARD_7_0,
                computeType: ComputeType.SMALL
            },
            buildSpec: aws_codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    build: {
                        commands: [
                            'mvn --quiet install spring-boot:repackage'
                        ]
                    }
                },
                artifacts: {
                    files: [
                        'target/ChickenCoop-1.0-SNAPSHOT.jar',
                        'appspec.yml',
                        'sql/tables.sql',
                        'scripts/aws/*.sh'
                    ],
                    'discard-paths': 'yes'
                }
            })
        })

        const sourceOutput = new aws_codepipeline.Artifact();
        const sourceAction = new aws_codepipeline_actions.GitHubSourceAction({
            actionName: "DownloadCode",
            owner: "zmiller91",
            repo: "ChickenCoop",
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

        const codeDeployApp = new aws_codedeploy.ServerApplication(this, "ChickenCoopCodeDeployApp", {
                applicationName: "ChickenCoop",
            }
        )

        const codeDeployRole = new aws_iam.Role(this, 'ChickenCoopCodeDeployRole', {
            assumedBy: new aws_iam.ServicePrincipal('codedeploy.amazonaws.com'),
        });

        const codeDeployGroup = new aws_codedeploy.ServerDeploymentGroup(this, 'ChickenCoopCodeDeployGroup', {
            application: codeDeployApp,
            role:codeDeployRole,
            deploymentGroupName: "ChickenCoopDeployGroup",
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
        const codePipeline = new Pipeline(this, "ChickenCoopServerPipeline", {
            pipelineName: "ChickenCoopBuildPipeline",
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

        if(database.secret) {
            ec2Role.addToPolicy(new aws_iam.PolicyStatement({
                actions: ["secretsmanager:GetSecretValue"],
                resources: [database.secret.secretArn]
            }))
        }
    }
}