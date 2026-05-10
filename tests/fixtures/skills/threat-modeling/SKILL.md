---
name: threat-modeling
description: Use when designing new features, APIs, or system components - guides STRIDE-based threat analysis to identify security concerns early
---

# Threat Modeling

Systematic process for identifying, evaluating, and mitigating security threats in systems, applications, and networks.

## Source Documents

- [Routine for Threat Modelling](https://bidbax.sharepoint.com/SiteAssets/SitePages/Informasjonssikkerhet/Routine-for-Threat-Modelling.pdf)
- [SSDLC Standard](https://bidbax.sharepoint.com/SiteAssets/SitePages/Informasjonssikkerhet/Secure-Software-Development-LifeCycle-SSDLC.pdf)
- [OWASP Threat Modeling](https://owasp.org/www-community/Threat_Modeling)
- [OWASP Top 10 2025: A06 Insecure Design](../owasp-top10-review/references/a06-2025-insecure-design.md)
- [Microsoft STRIDE](https://docs.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats)

## When To Use

**Primary trigger:** You are DESIGNING something new (before implementation).

Invoke this skill when:
- Designing a new feature or component
- Adding new API endpoints
- Introducing new data flows
- Changing system architecture
- Integrating with external systems

**Phase:** Design (before implementation begins)

## When NOT To Use (Use Another Skill)

| Situation | Use Instead |
|-----------|-------------|
| Reviewing existing code/PR | `security-code-review` |
| Documenting a known risk | `risk-assessment` |
| Classifying data fields | `data-classification` (then come back here) |
| Responding to CVE/vuln alert | `vulnerability-triage` |
| General "is this risky?" question | `risk-assessment` |

## Relationship to Other Skills

```
threat-modeling (DESIGN)
        │
        ├──► Found sensitive data? ──► data-classification
        │
        ├──► Found risks to track? ──► risk-assessment
        │
        └──► Ready to implement? ──► security-code-review (for PR)
                                     access-control-review (if auth)
                                     cryptography-review (if crypto)
```

**Key distinction from risk-assessment:**
- `threat-modeling`: "What can ATTACKERS do?" (STRIDE analysis of design)
- `risk-assessment`: "What could go WRONG?" (document and track any risk)

## SSDLC Integration

Threat modeling is required at the **Design phase** (Activity 3.1):

| Activity | Responsible | Accountable | Supporting |
|----------|-------------|-------------|------------|
| 3.1 Perform threat modelling | Tech-lead | Product Manager | CISO, DPO, SGM, Principal Architect |

## Frequency

| Trigger | Action |
|---------|--------|
| **Start of Project** | Full threat model during planning and design phases |
| **Post-Deployment** | Review and update periodically, especially after major updates |
| **After Identified Threats** | Revisit when new vulnerabilities discovered in broader ecosystem |

## Roles and Responsibilities

| Role | Responsibility |
|------|----------------|
| **Team Security** | Ensure security best practices, review risks, help with analysis, ensure mitigations |
| **Product Team** | Lead threat modeling, explain design, provide insights on weaknesses, collaborate on mitigations |
| **System Architects** | Identify architectural vulnerabilities based on design choices |

## Process

### 1. Identify Assets

List and categorize valuable assets that need protection:
- Sensitive data
- Intellectual property
- Critical infrastructure
- User information

### 2. Create Data Flow Diagram

Required by SSDLC Activity 2.5:

The architecture diagram shall:
- Identify and document entry points (external interfaces)
- Identify input and data sources/sinks for entry points
- Identify protocols that transport data over entry points
- Identify and classify data/information processed by the application

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│  External    │──HTTPS──│   Process    │──gRPC───│   Service    │
│  Entity      │         │              │         │              │
└──────────────┘         └──────────────┘         └──────────────┘
                                │                        │
                         [Trust Boundary]                │
                                                         ▼
                                                  ┌──────────────┐
                                                  │  Data Store  │
                                                  │              │
                                                  └──────────────┘
```

### 3. Identify Threats (STRIDE)

For each component and data flow, consider:

| Threat | Description | Question to Ask |
|--------|-------------|-----------------|
| **S**poofing | Impersonating another entity | Can an attacker pretend to be this entity? |
| **T**ampering | Modifying data or components | Can an attacker modify this data/process? |
| **R**epudiation | Denial of actions | Can actions be denied without proof? |
| **I**nformation Disclosure | Exposing data to unauthorized parties | Can data leak to unauthorized parties? |
| **D**enial of Service | Disrupting service availability | Can this be made unavailable? |
| **E**levation of Privilege | Gaining unauthorized access | Can an attacker gain higher privileges? |

### 4. Identify Vulnerabilities

Assess system architecture for:
- Design flaws
- Missing security controls
- Weak authentication
- Improper configurations
- Unsecured communications

### 5. Analyze and Prioritize

Assess likelihood and potential impact of identified threats:
- Rank threats based on severity
- Prioritize highest risk threats

Use DREAD for prioritization:
- **D**amage potential
- **R**eproducibility
- **E**xploitability
- **A**ffected users
- **D**iscoverability

### 6. Develop Mitigations

Create actionable mitigation strategies for each threat.

### 7. Review and Validate

Ensure mitigations are:
- Properly integrated into system design
- Effective at reducing/eliminating identified risks

## Residual Risk Handling

From Routine for Threat Modelling:

> All open or partially mitigated vulnerabilities must be registered in the Product's Jira Project and analyzed in accordance with Standard for Operational Risk Management.

All Jira-registered Risks must be followed up in ROS process.

## Documentation Requirements

Threat model documentation must include:
- [ ] Description of assets being protected
- [ ] Identified threats and vulnerabilities
- [ ] Risk assessments (likelihood and impact analysis)
- [ ] Mitigation strategies and security controls implemented

## Output Template

```markdown
# Threat Model: [Feature/Component Name]

**Date:** YYYY-MM-DD
**Author:** [Name]
**Version:** 1.0
**Related:** [Design doc, PR, Issue links]
**Product/Service:** [Name]

## Scope

### In Scope
- [Component 1]
- [Component 2]
- [Data flow X to Y]

### Out of Scope
- [Existing component not being changed]
- [Infrastructure concerns handled elsewhere]

## System Overview

[Brief description of what this feature/component does]

## Assets

| Asset | Classification | Description |
|-------|---------------|-------------|
| User credentials | Restricted | Passwords, tokens |
| PII | Restricted | Names, emails, NNIN |
| Session data | Confidential | Session tokens, state |

## Data Flow Diagram

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│    User      │──HTTPS──│   API GW     │──gRPC───│   Service    │
│  (Browser)   │         │              │         │              │
└──────────────┘         └──────────────┘         └──────────────┘
                                │                        │
                         [Trust Boundary]                │
                                                         ▼
                                                  ┌──────────────┐
                                                  │   Database   │
                                                  │              │
                                                  └──────────────┘
```

## Threat Analysis

### T-001: [Threat Title]

- **Component:** [Which component]
- **STRIDE:** Spoofing / Tampering / Repudiation / Information Disclosure / DoS / Elevation of Privilege
- **Description:** [What could an attacker do?]
- **Attack Vector:** [How would they do it?]
- **Impact:** High / Medium / Low
- **Likelihood:** High / Medium / Low
- **Mitigations:**
  - [Mitigation 1]
  - [Mitigation 2]
- **Status:** Mitigated / Accepted / Needs Work
- **Jira Risk:** [If residual risk, provide ticket ID]

[Repeat for each threat]

## Summary

| STRIDE Category | Threats Found | Mitigated | Accepted | Needs Work |
|-----------------|---------------|-----------|----------|------------|
| Spoofing        | X             | X         | X        | X          |
| Tampering       | X             | X         | X        | X          |
| Repudiation     | X             | X         | X        | X          |
| Info Disclosure | X             | X         | X        | X          |
| Denial of Service | X           | X         | X        | X          |
| Elevation of Privilege | X      | X         | X        | X          |

## Recommendations

1. [Priority recommendation 1]
2. [Priority recommendation 2]
3. [Priority recommendation 3]

## Approvals

- [ ] Security team review
- [ ] Architecture review
- [ ] Residual risks registered in Jira
```

## Continuous Improvement

- **Feedback and Review**: Gather feedback from all stakeholders after each session
- **Post-Implementation Review**: Regularly review implemented systems for mitigation effectiveness
- **Update for New Threats**: Factor new risks into future exercises

## Limitations

> Threat modelling is a proactive, but not foolproof, approach to security. While it helps to mitigate many risks, it cannot guarantee absolute security. Continuous monitoring and regular updates are essential to adapting to emerging threats.

## Examples

### Example: API Endpoint Threat

**T-001: Unauthorized Access to User Data**

- **Component:** GET /api/users/{id}
- **STRIDE:** Information Disclosure
- **Description:** Attacker could access other users' data by guessing/enumerating user IDs
- **Attack Vector:** IDOR - change user ID in URL to access other users
- **Impact:** High (PII exposure)
- **Likelihood:** High (trivial to exploit)
- **Mitigations:**
  - Verify requesting user owns the resource
  - Use non-sequential UUIDs instead of integer IDs
  - Implement rate limiting on enumeration attempts
- **Status:** Needs Work - authz check missing
- **Jira Risk:** RISK-2024-042

## References

- Routine for Threat Modelling
- Standard for Secure Software Development LifeCycle (SSDLC)
- Standard for operasjonell risikostyring
- OWASP Threat Modeling Cheat Sheet
- Microsoft STRIDE Model
