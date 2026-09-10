# Preserve full capabilities in the first hosted deployment

## Status

Superseded in part by ADR-0010 on 2026-09-07: MP4 export is deferred. Other current capabilities remain in scope. Preserve this record as the earlier decision, not as the current launch checklist.

## Context and decision

During deployment planning, the user explicitly selected “当前全部功能都必须保留，包括 MP4 导出”. The first hosted release must retain the current application capabilities, including Pro agent execution, material processing, and MP4 export. A classic-only release or replacing MP4 export with ZIP download does not satisfy this scope. This preserves existing capabilities; it does not expand deployment into implementing deferred assessment features merely described in older planning documents.

## Consequences

Deployment planning must provide execution environments for the current long-running processes and isolated Chromium/FFmpeg render service, and must account for their durable files. The current Next.js deployment on Vercel plus a hosted PostgreSQL database alone has not been shown to meet this requirement. A Vercel hybrid architecture and an earlier move to a persistent server are still alternatives under discussion, not accepted deployment decisions.
