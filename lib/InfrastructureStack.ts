import * as cdk from "aws-cdk-lib";
import {
    aws_certificatemanager,
    aws_ec2,
    aws_elasticloadbalancingv2,
    aws_elasticloadbalancingv2_targets,
    aws_iam,
    aws_rds,
    aws_route53,
    aws_route53_targets,
    aws_secretsmanager,
    aws_ses, Duration,
    Tags
} from "aws-cdk-lib";
import {Construct} from "constructs";
import {IpAddresses} from "aws-cdk-lib/aws-ec2";
import fs from "node:fs";
import {ApplicationProtocol, ListenerCondition} from "aws-cdk-lib/aws-elasticloadbalancingv2";

export class InfrastructureStack extends cdk.Stack {

    readonly ec2Role: aws_iam.Role;
    readonly dbSecret?: aws_secretsmanager.ISecret;

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
            securityGroups: [dbSecurityGroup],
            vpcSubnets: {subnets: vpc.publicSubnets},
        });

        this.dbSecret = database.secret;



        dbSecurityGroup.addIngressRule(aws_ec2.Peer.ipv4(vpc.vpcCidrBlock), aws_ec2.Port.tcp(3306))


        // Creat the EC2 image that hosts the app, assign it a public IP, and allow ssh access
        this.ec2Role = new aws_iam.Role(this, 'ChickenCoopEc2CodeDeployRole', {
            assumedBy: new aws_iam.ServicePrincipal('ec2.amazonaws.com'),
        });

        this.ec2Role.addToPolicy(new aws_iam.PolicyStatement({
            effect: aws_iam.Effect.ALLOW,
            actions: [
                "ses:SendEmail",
                "ses:SendRawEmail"
            ],
            resources: ["*"]
        }));

        if(database.secret) {
            this.ec2Role.addToPolicy(new aws_iam.PolicyStatement({
                actions: ["secretsmanager:GetSecretValue"],
                resources: [database.secret.secretArn]
            }))
        }

        const appDbSecret = new aws_secretsmanager.Secret(this, "ChickenCoopAppDbSecret", {
            secretName: "app-user-creds",
            generateSecretString: {
                secretStringTemplate: JSON.stringify({
                    username: "app",
                    host: database.dbInstanceEndpointAddress,
                    port: database.dbInstanceEndpointPort,
                }),
                generateStringKey: "password",
                excludePunctuation: true,
            },
        });

        this.ec2Role.addToPolicy(new aws_iam.PolicyStatement({
            actions: ["secretsmanager:GetSecretValue"],
            resources: [appDbSecret.secretArn]
        }))

        const instanceProfile = new aws_iam.InstanceProfile(this, 'ChickenCoopInstanceProfile', {
            role: this.ec2Role,
            instanceProfileName: "ChickenCoopInstanceProfile",
        })

        const codeDeployScript = fs.readFileSync('scripts/code-deploy-agent.sh', 'utf8')

        const userData = aws_ec2.UserData.forLinux();
        userData.addCommands(
            'yes y | sudo yum install java-17-amazon-corretto-headless',
            'yes y | sudo dnf install mariadb105',
            'yes y | sudo yum install certbot-apache',
            'yes y | sudo yum install nodejs npm',
            // 'sudo ln -s /snap/bin/certbot /usr/bin/certbot',
            // 'certbot-3 ',
            // 'sudo certbot-3 certonly --standalone --non-interactive --agree-tos --email \'me@zackmiller.info\' --domains api.pisprout.com',
            // 'sudo openssl pkcs12 -export -in /etc/letsencrypt/live/api.pisprout.com/fullchain.pem -inkey /etc/letsencrypt/live/api.pisprout.com/privkey.pem -out apipisprout.pfx -password pass:password',
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
        ec2SecurityGroup.connections.allowFrom(dbSecurityGroup, aws_ec2.Port.allTcp())

        // Create the load balancer for the ec2 instance
        const apiTarget = new aws_elasticloadbalancingv2_targets.InstanceTarget(ec2Instance, 8080);
        const uiTarget = new aws_elasticloadbalancingv2_targets.InstanceTarget(ec2Instance, 3000);

        const lbSecurityGroup = new aws_ec2.SecurityGroup(this, "LBSecurityGroup", {
            vpc: vpc
        })


        ec2SecurityGroup.connections.allowFrom(lbSecurityGroup, aws_ec2.Port.allTcp())

        const lb = new aws_elasticloadbalancingv2.ApplicationLoadBalancer(this, "LB", {
            vpc: vpc,
            internetFacing: true,
            securityGroup: lbSecurityGroup
        });


        const sslCert = aws_certificatemanager.Certificate.fromCertificateArn(this, "SSLCert", "arn:aws:acm:us-east-1:547228847576:certificate/73c9dbb8-7308-48dd-8730-2acf6e853656")
        const listener = lb.addListener("Applications", {
            port: 443,
            open: true,
            certificates: [sslCert]
        });

        listener.addTargets("APITarget", {
            port: 8080,
            priority: 2,
            conditions: [
                aws_elasticloadbalancingv2.ListenerCondition.hostHeaders(['api.pisprout.com']),
            ],
            targets: [apiTarget]
        });

        listener.addTargets("UITarget", {
            port: 3000,
            protocol: ApplicationProtocol.HTTP,
            targets: [uiTarget]
        });

        // Update Route53
        const hostedZone = aws_route53.HostedZone.fromHostedZoneAttributes(this, "PiHostedZone", {
            hostedZoneId: "ZV0LM3FLDZFHM",
            zoneName: "pisprout.com"
        });

        const apiARecord = new aws_route53.ARecord(this, "APIARecord", {
            target: aws_route53.RecordTarget.fromAlias(new aws_route53_targets.LoadBalancerTarget(lb)),
            zone: hostedZone,
            recordName: "api",
        })

        const webARecord = new aws_route53.ARecord(this, "WebARecord", {
            target: aws_route53.RecordTarget.fromAlias(new aws_route53_targets.LoadBalancerTarget(lb)),
            zone: hostedZone,
            recordName: "",
        })

        const wwwWebARecord = new aws_route53.ARecord(this, "WWWWebARecord", {
            target: aws_route53.RecordTarget.fromAlias(new aws_route53_targets.LoadBalancerTarget(lb)),
            zone: hostedZone,
            recordName: "www",
        })


        /**
         * Currently everything is running under the pisprout.com domain, however I want this all to run under the
         * gnomelyhq.com domain in the future. So this SES email verification is using the gnomelyhq.com domain.
         *
         * Also, these DKIM and MX records need to be added to the domain's DNS records. Currently, WordPress is
         * the name server so these need to be manually copied to wordpress. Later we will use Route53, in which
         * this code will work as intended.
         */

        const domain = 'gnomelyhq.com';

        const zone = aws_route53.HostedZone.fromLookup(this, 'Zone', {
            domainName: domain,
        });

        const identity = new aws_ses.EmailIdentity(this, 'SesIdentity', {
            identity: aws_ses.Identity.domain(domain),
            mailFromDomain: `mail.${domain}`,
        });

        // DKIM: create the 3 CNAME records SES expects
        identity.dkimRecords.forEach((record, index) => {
            new aws_route53.CnameRecord(this, `SesDkimRecord${index}`, {
                zone,
                recordName: `${record.name}._domainkey`, // relative to zone
                domainName: record.value,
                ttl: Duration.minutes(5),
            });
        });

        // SPF at the root of the domain (zone apex)
        new aws_route53.TxtRecord(this, 'SesSpfRecord', {
            zone,
            // recordName omitted or '' means the zone apex (gnomelyhq.com)
            values: ['v=spf1 include:amazonses.com ~all'],
            ttl: Duration.minutes(5),
        });

        // MAIL FROM: MX record required by SES
        new aws_route53.MxRecord(this, 'SesMailFromMx', {
            zone,
            recordName: 'mail',
            values: [{
                hostName: 'feedback-smtp.us-east-1.amazonses.com',
                priority: 10,
            }],
            ttl: Duration.minutes(5),
        });

        // MAIL FROM: SPF record (this is the important one for Return-Path)
        new aws_route53.TxtRecord(this, 'SesMailFromSpf', {
            zone,
            recordName: 'mail',
            values: ['v=spf1 include:amazonses.com -all'],
            ttl: Duration.minutes(5),
        });

    }
}