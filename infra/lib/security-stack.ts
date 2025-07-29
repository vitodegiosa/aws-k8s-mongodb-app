import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ApplicationLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { LoadBalancerV2Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { CfnLoggingConfiguration, CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { AllowedMethods, CachePolicy, Distribution, OriginProtocolPolicy, ResponseHeadersPolicy, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';

/**
 * Cloudfront Distribution: Enforce HTTPS, absorb DDoS
 * WAF Web ACL on CF: Preventative controls on common threats
 * WAF Web ACL on ALB: prevent direct access to the ALB
 */
export class SecurityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const alb = ApplicationLoadBalancer.fromLookup(this, "ALB", {
      loadBalancerTags: {
        'ingress.eks.amazonaws.com/stack': 'default/sample-app-ingress'
      }
    });

    const customHeaderSecret = new Secret(this, 'CloudFrontHeaderSecret', {
      generateSecretString: {
        excludePunctuation: true, // Exclude all punctuation
        includeSpace: false,
        passwordLength: 32,
      },
    });
    const customHeaderName = 'X-CloudFront-Secret';
    const customHeaderValue = customHeaderSecret.secretValue.unsafeUnwrap();

    const albOrigin = new LoadBalancerV2Origin(alb, {
      // CloudFront will connect to the ALB.
      // For most EKS setups with ALB Ingress, the ALB terminates TLS, and pods receive HTTP.
      // So, CloudFront should generally connect to the ALB's HTTP listener.
      protocolPolicy: OriginProtocolPolicy.HTTP_ONLY,
      
      // Optionally, add a custom header for security as mentioned before
      customHeaders: {
        [customHeaderName]: customHeaderValue
      },
    });

    // WAF ACL for ALB
    const albWebAcl = new CfnWebACL(this, 'AlbProtectionWebAcl', {
      defaultAction: { block: {} }, // Default action is to block
      scope: 'REGIONAL', // ALB is regional, so WAF scope is REGIONAL
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'alb-waf-metric',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AllowCloudFrontHeaderRule',
          priority: 1, // High priority to allow CloudFront traffic first
          action: { allow: {} }, // Allow requests that match this rule
          statement: {
            byteMatchStatement: {
              fieldToMatch: {
                singleHeader: { name: customHeaderName },
              },
              textTransformations: [{ priority: 0, type: 'NONE' }],
              positionalConstraint: 'EXACTLY',
              searchString: customHeaderValue,
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'allow-cloudfront-header-rule-metric',
            sampledRequestsEnabled: true,
          },
        }
      ],
    });
    new CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: alb.loadBalancerArn,
      webAclArn: albWebAcl.attrArn,
    });

    // WAF ACL for Cloudfront
    const webAcl = new CfnWebACL(this, 'CloudfrontWebAcl', {
      defaultAction: { allow: {} }, // Default action is to allow requests
      scope: 'CLOUDFRONT', // Required for CF association
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'CloudfrontWebAclMetric',
        sampledRequestsEnabled: true,
      },
      name: 'CloufrontbWebAcl',
      description: 'Web ACL for protecting the Cloudfront Distribution',
      rules: [
        // Add AWS Managed Rule Group for common vulnerabilities
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          overrideAction: { none: {} }, // Use the default action of the managed rule group
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedRulesCommonRuleSetMetric',
            sampledRequestsEnabled: true,
          },
        }
      ]
    });

    const wafLogGroup = new LogGroup(this, 'WafAccessLogGroup', {
      logGroupName: 'aws-waf-logs-cfacl', // Choose a descriptive name
      retention: RetentionDays.ONE_MONTH, // Adjust retention as needed
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Or RETAIN for production
    });

    // 2. Create an IAM Role for WAF to write to the Log Group
    const wafLoggingRole = new Role(this, 'WafLoggingRole', {
      assumedBy: new ServicePrincipal('waf.amazonaws.com'),
      description: 'IAM role for AWS WAF to write logs to CloudWatch Logs',
    });
    wafLogGroup.grantWrite(wafLoggingRole);
    wafLoggingRole.addToPolicy(new PolicyStatement({
      actions: [
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      resources: [wafLogGroup.logGroupArn],
    }));

    new CfnLoggingConfiguration(this, "WebAclLoggingConfiguration", {
      resourceArn: webAcl.attrArn,
      logDestinationConfigs: [`arn:aws:logs:${this.region}:${this.account}:log-group:${wafLogGroup.logGroupName}`]
    })

    const distribution = new Distribution(this, 'CloudFrontDefaultCertDistribution', {
      defaultBehavior: {
        origin: albOrigin,
        // Ensure viewers are redirected to HTTPS
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.USE_ORIGIN_CACHE_CONTROL_HEADERS,
        responseHeadersPolicy: ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS_AND_SECURITY_HEADERS
      },
      additionalBehaviors: {
        '/assets/*': {
          origin: albOrigin,
          // Ensure viewers are redirected to HTTPS
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: CachePolicy.CACHING_OPTIMIZED
        }
      },
      webAclId: webAcl.attrArn
    });

  }
}