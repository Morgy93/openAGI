# Signal memory evidence

Signals accepted by scrutiny retain their summary and body before decision diagnostics in tiered memory. This preserves concrete evidence when integrations use the same summary for different events, and lets exact automated deduplication distinguish those events. Tier fidelity and existing compression limits still apply; memory is not a full event archive.

Summary-only signals remain supported. Ignored signals and ephemeral connectivity probes are not committed to memory. The change applies to future accepted signals; missing bodies in existing memories are not reconstructed or rewritten.
