#!/usr/bin/env python3
"""
Generate professional PDF report comparing Claude Agent SDK vs LangChain/LangGraph
"""

import os
import sys
from datetime import datetime
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Image, PageBreak,
    Table, TableStyle
)
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib import colors

# Change to workspace directory for relative paths
os.chdir('/Users/ridhamkhandar/Desktop/chat-app-capstone/fixtures/workspace-001')

# Ensure output directory exists
os.makedirs('files/reports', exist_ok=True)

# Create document
doc = SimpleDocTemplate(
    "files/reports/ai_agent_framework_market_20260611.pdf",
    pagesize=letter,
    rightMargin=72, leftMargin=72,
    topMargin=72, bottomMargin=72
)

# Get styles and create custom styles
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name='Justify',
    alignment=TA_JUSTIFY,
    fontSize=11,
    leading=14,
    spaceAfter=12
))

styles.add(ParagraphStyle(
    name='CustomTitle',
    parent=styles['Heading1'],
    fontSize=18,
    textColor=colors.HexColor('#1a1a1a'),
    spaceAfter=6,
    alignment=TA_CENTER
))

styles.add(ParagraphStyle(
    name='CustomHeading1',
    parent=styles['Heading1'],
    fontSize=14,
    textColor=colors.HexColor('#2c3e50'),
    spaceAfter=10,
    spaceBefore=12
))

styles.add(ParagraphStyle(
    name='CustomHeading2',
    parent=styles['Heading2'],
    fontSize=12,
    textColor=colors.HexColor('#34495e'),
    spaceAfter=8,
    spaceBefore=10
))

styles.add(ParagraphStyle(
    name='BulletStyle',
    parent=styles['Normal'],
    fontSize=11,
    leading=13,
    leftIndent=20,
    spaceAfter=6
))

story = []

# Title
story.append(Paragraph(
    "AI Agent Framework Market: Claude Agent SDK vs LangChain/LangGraph",
    styles['CustomTitle']
))
story.append(Paragraph("Technical Capabilities Comparison 2026", styles['Normal']))
story.append(Paragraph(f"<i>Report Date: {datetime.now().strftime('%B %d, %Y')}</i>", styles['Normal']))
story.append(Spacer(1, 0.3*inch))

# Executive Summary
story.append(Paragraph("Executive Summary", styles['CustomHeading1']))
exec_summary = (
    "The AI agent framework landscape has matured significantly by mid-2026, with two distinct ecosystems emerging: "
    "LangChain/LangGraph targeting broad integration and complex orchestration, and Claude Agent SDK emphasizing developer "
    "experience and focused capability. LangChain maintains market leadership with 1000+ integrations and v1.0 stability, "
    "while Claude SDK differentiates through native IDE integration (Xcode 26.3) and rapid prototyping. Both frameworks "
    "support Python and JavaScript, achieve production-ready status, and excel in different use cases. This report provides "
    "a comprehensive technical comparison to guide framework selection based on specific requirements."
)
story.append(Paragraph(exec_summary, styles['Justify']))
story.append(Spacer(1, 0.2*inch))

# Key Findings - Integration Ecosystem
story.append(Paragraph("Key Findings", styles['CustomHeading1']))
story.append(Paragraph("1. Integration Ecosystem & Provider Support", styles['CustomHeading2']))
finding1 = (
    "LangChain dominates in integration breadth with 1000+ total integrations across models, tools, vector stores, "
    "document loaders, APIs, and data platforms, compared to Claude Agent SDK's focused ~15 core integrations. LangChain "
    "supports 100+ LLM providers (OpenAI, Anthropic, Google, Cohere, open-source models) with a unified interface, while "
    "Claude SDK targets the three latest Claude models (Sonnet 4.6, Opus 4.7, Opus 4.8). Claude SDK compensates through "
    "the Model Context Protocol (MCP) for enterprise integrations (Jira, Slack, custom endpoints), representing a strategic "
    "choice between breadth and depth. <b>Winner: LangChain for integration breadth (65x more direct integrations); Claude "
    "SDK for focused approach and enterprise MCP support.</b>"
)
story.append(Paragraph(finding1, styles['Justify']))
story.append(Spacer(1, 0.15*inch))

story.append(Paragraph("2. Language Support & Developer Experience", styles['CustomHeading2']))
finding2 = (
    "Both frameworks converge on Python and JavaScript/TypeScript support, indicating industry standardization around these "
    "ecosystems. Claude Agent SDK differentiates through superior developer experience: interactive project scaffolding with "
    "automatic setup, native Xcode 26.3 integration providing full IDE features (subagents, background tasks, plugins), and "
    "/workflows command for dynamic multi-agent composition. LangChain 1.0 emphasizes streamlined APIs for rapid prototyping "
    "and refined component models based on community feedback. <b>Winner: Claude SDK for IDE integration (9/10 vs 4/10); "
    "LangChain for ecosystem flexibility.</b>"
)
story.append(Paragraph(finding2, styles['Justify']))
story.append(Spacer(1, 0.15*inch))

story.append(Paragraph("3. Performance & Production Readiness", styles['CustomHeading2']))
finding3 = (
    "LangGraph achieves 2.70 requests/second throughput with 10,155ms P95 latency (optimized configuration), demonstrating "
    "production viability. Rust-based competitors achieve 4.97 rps at 9,652ms, representing 84% throughput improvement and 7% "
    "latency advantage—revealing Python overhead at scale. State persistence shows variable latency: in-memory checkpoints "
    "(10-50ms), PostgreSQL (50-200ms), and cloud storage (100-500ms). LangGraph v1.0 (October 2025) and Claude SDK (June 2026) "
    "both reached stability milestones. <b>Winner: Tie for production readiness; LangGraph more optimized for high-scale "
    "concurrent loads.</b>"
)
story.append(Paragraph(finding3, styles['Justify']))
story.append(Spacer(1, 0.15*inch))

story.append(PageBreak())

# Page 2 content
story.append(Paragraph("4. Multi-Agent Orchestration & State Management", styles['CustomHeading2']))
finding4 = (
    "LangGraph implements directed graph topology with nodes (functions/LLM calls) and conditional edges, providing "
    "sophisticated routing logic and built-in persistence. State automatically persists as Python TypedDicts across "
    "interruptions, enabling multi-day approval workflows. Claude SDK uses isolated subagent contexts with parallel "
    "execution, all agents sharing the same sandbox and filesystem. Claude SDK conversation logs serve as state source of "
    "truth with durable storage in PostgreSQL, Redis, or object storage. Both support human-in-the-loop patterns through "
    "first-class APIs (LangGraph) or explicit checkpoint patterns (Claude). <b>Winner: Tie; different architectural approaches "
    "suit different use cases (graph-centric vs application-driven).</b>"
)
story.append(Paragraph(finding4, styles['Justify']))
story.append(Spacer(1, 0.15*inch))

story.append(Paragraph("5. Advanced Features & Recent Releases", styles['CustomHeading2']))
finding5 = (
    "LangGraph 1.0 (October 2025) introduced automatic state persistence, node caching, deferred execution, and pre/post model "
    "hooks for token management and safeguards. Claude SDK June 2026 updates include scheduled deployments on managed infrastructure, "
    "environment variable credential injection, and dynamic workflow composition. LangChain 1.0 shifted focus to agent-centric design "
    "built on LangGraph runtime, with middleware system for custom logic injection. Both ecosystems support feature parity between "
    "Python and JavaScript versions with concurrent release cycles. <b>Winner: LangGraph edges slightly ahead with node caching and "
    "deferred execution optimizations; Claude SDK leads on deployment automation and IDE integration.</b>"
)
story.append(Paragraph(finding5, styles['Justify']))
story.append(Spacer(1, 0.15*inch))

# Feature comparison table
story.append(Paragraph("Technical Capabilities Matrix", styles['CustomHeading2']))
table_data = [
    ['Feature', 'LangChain/LangGraph', 'Claude Agent SDK', 'Winner'],
    ['LLM Provider Support', '100+ providers', '3 latest Claude models', 'LangChain'],
    ['Total Integrations', '1000+ pre-built', '~15 core (MCP extensible)', 'LangChain'],
    ['State Persistence', 'Automatic (LangGraph 1.0)', 'Conversation log + storage', 'Tie'],
    ['Human-in-Loop', 'First-class API', 'Checkpoint patterns', 'Tie'],
    ['IDE Integration', 'Limited (4/10)', 'Native Xcode 26.3 (9/10)', 'Claude SDK'],
    ['Production Readiness', 'v1.0 stable (Oct 2025)', 'v1.0 stable (June 2026)', 'Tie'],
    ['Multi-Agent Support', 'LangGraph native', 'Subagents with isolation', 'Tie'],
]

table = Table(table_data, colWidths=[1.5*inch, 1.5*inch, 1.5*inch, 1*inch])
table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#2c3e50')),
    ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
    ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTSIZE', (0, 0), (-1, 0), 10),
    ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
    ('BACKGROUND', (0, 1), (-1, -1), colors.beige),
    ('GRID', (0, 0), (-1, -1), 1, colors.black),
    ('FONTSIZE', (0, 1), (-1, -1), 9),
    ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f5f5f5')]),
]))
story.append(table)
story.append(Spacer(1, 0.2*inch))

# Framework Selection Guidance
story.append(Paragraph("Framework Selection Guide", styles['CustomHeading1']))

story.append(Paragraph("Choose LangChain/LangGraph if you need:", styles['BulletStyle']))
story.append(Paragraph(
    "• Integration with 100+ LLM providers and diverse data sources (RAG pipelines, vector databases, document loaders)",
    styles['BulletStyle']
))
story.append(Paragraph(
    "• Complex multi-agent orchestration with sophisticated conditional routing and graph-based workflows",
    styles['BulletStyle']
))
story.append(Paragraph(
    "• Long-running background jobs with human approval gates and resumable workflows",
    styles['BulletStyle']
))
story.append(Paragraph(
    "• Production-grade observability through LangSmith integration and debugging tools",
    styles['BulletStyle']
))
story.append(Spacer(1, 0.12*inch))

story.append(Paragraph("Choose Claude Agent SDK if you need:", styles['BulletStyle']))
story.append(Paragraph(
    "• Rapid prototyping with native IDE support (Xcode 26.3) and built-in scaffolding",
    styles['BulletStyle']
))
story.append(Paragraph(
    "• Application-driven agent architecture where your code controls agent behavior",
    styles['BulletStyle']
))
story.append(Paragraph(
    "• Enterprise integrations via MCP protocol with secure credential management",
    styles['BulletStyle']
))
story.append(Paragraph(
    "• Scheduled deployments with environment variable credentials on managed infrastructure",
    styles['BulletStyle']
))
story.append(Spacer(1, 0.2*inch))

# Conclusion
story.append(Paragraph("Conclusion", styles['CustomHeading1']))
conclusion = (
    "The Claude Agent SDK and LangChain/LangGraph represent complementary approaches to AI agent development in 2026. "
    "LangChain's dominance stems from its expansive integration ecosystem (1000+ pre-built connections) and production-proven "
    "LangGraph runtime with sophisticated state management—making it the de facto standard for multi-agent orchestration and "
    "complex RAG pipelines. Claude Agent SDK differentiates through superior developer experience (native Xcode integration, "
    "interactive scaffolding) and focused capability set optimized for rapid prototyping and application-driven architectures. "
    "Both frameworks achieved v1.0 maturity (October 2025 and June 2026 respectively), supporting Python and JavaScript with "
    "comparable multi-agent capabilities. Selection should prioritize integration breadth and orchestration complexity (LangChain) "
    "versus developer experience and deployment automation (Claude SDK). Organizations may benefit from hybrid approaches, using "
    "Claude SDK for initial development and prototyping while leveraging LangChain for production orchestration at scale."
)
story.append(Paragraph(conclusion, styles['Justify']))
story.append(Spacer(1, 0.25*inch))

# Sources
story.append(Paragraph("Sources & References", styles['CustomHeading1']))
sources = [
    "Anthropic. (2026). Building agents with the Claude Agent SDK. Retrieved from https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk",
    "LangChain Blog. (2025). LangChain and LangGraph Agent Frameworks Reach v1.0 Milestones. Retrieved from https://blog.langchain.com/langchain-langgraph-1dot0/",
    "Blockchain Council. (2026). LangChain in 2026: Building Reliable Agents and RAG Pipelines. Retrieved from https://www.blockchain-council.org/ai/langchain-2026-reliable-agents-langchain-rag/",
    "Aerospike. (2026). LangGraph in Production: Latency, Replay, and Scale. Retrieved from https://aerospike.com/blog/langgraph-production-latency-replay-scale/",
    "Anthropic. (2026). Apple's Xcode now supports the Claude Agent SDK. Retrieved from https://www.anthropic.com/news/apple-xcode-claude-agent-sdk",
    "DEV Community. (2026). Benchmarking AI Agent Frameworks in 2026. Retrieved from https://dev.to/saivishwak/benchmarking-ai-agent-frameworks-in-2026-autoagents-rust-vs-langchain-langgraph-llamaindex-338f",
]

for i, source in enumerate(sources, 1):
    story.append(Paragraph(f"{i}. {source}", styles['Normal']))
    story.append(Spacer(1, 0.08*inch))

# Build PDF
doc.build(story)
print("PDF successfully generated: files/reports/ai_agent_framework_market_20260611.pdf")
print(f"File location: /Users/ridhamkhandar/Desktop/chat-app-capstone/fixtures/workspace-001/files/reports/ai_agent_framework_market_20260611.pdf")
