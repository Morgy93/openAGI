# Signal memory evidence

Signals accepted by scrutiny retain their body first, followed by the summary and decision diagnostics in tiered memory. This preserves concrete evidence when integrations use the same summary for different events, and lets exact automated deduplication distinguish those events. Tier fidelity and existing compression limits still apply; memory is not a full event archive.

Summary-only signals remain supported, including the normalization fallback that copies the summary into the body; identical summary/body text is stored once. Body-first ordering keeps long summaries from crowding concrete evidence out of compressed memories. Ignored signals and ephemeral connectivity probes are not committed to memory. The change applies to future accepted signals; missing bodies in existing memories are not reconstructed or rewritten.
