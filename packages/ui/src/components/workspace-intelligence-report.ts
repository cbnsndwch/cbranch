export interface WorkspaceIntelligenceReportFinding {
    readonly severity: 'info' | 'warning';
    readonly kind: string;
    readonly message: string;
}

export interface WorkspaceIntelligenceGraphPreview {
    readonly labels: ReadonlyArray<string>;
    readonly edgeCount: number;
    readonly isBounded: boolean;
}

export interface WorkspaceIntelligenceReportPreview {
    readonly findings: ReadonlyArray<WorkspaceIntelligenceReportFinding>;
    readonly graph: WorkspaceIntelligenceGraphPreview;
}

const architectureIntegrity = (markdown: string): string => {
    const match = markdown.match(
        /## Architecture integrity\s*([\s\S]*?)(?=\n## |$)/,
    );
    return match?.[1] ?? '';
};

const architectureSketch = (markdown: string): string => {
    const match = markdown.match(/```mermaid\s*([\s\S]*?)```/);
    return match?.[1] ?? '';
};

/**
 * The persisted report remains Markdown for exportability. The UI only extracts the
 * deliberately stable findings/sketch fragments that the artifact store produces so
 * a first-time user never has to interpret raw Markdown or Mermaid source.
 */
export const workspaceIntelligenceReportPreview = (
    markdown: string,
): WorkspaceIntelligenceReportPreview => {
    const findings = architectureIntegrity(markdown)
        .split('\n')
        .flatMap(line => {
            const match = line.match(
                /^- \*\*(info|warning)\*\* `([^`]+)`: (.+)$/,
            );
            return match === null
                ? []
                : [
                      {
                          severity: match[1] as 'info' | 'warning',
                          kind: match[2]!,
                          message: match[3]!,
                      },
                  ];
        });
    const sketch = architectureSketch(markdown);
    const labels = sketch
        .split('\n')
        .flatMap(line => {
            const match = line.match(/^N\d+\["(.+)"\]$/);
            return match === null ? [] : [match[1]!];
        })
        .slice(0, 8);

    return {
        findings,
        graph: {
            labels,
            edgeCount: sketch.split('\n').filter(line => line.includes('-->'))
                .length,
            isBounded: sketch.includes('TRUNCATED['),
        },
    };
};
