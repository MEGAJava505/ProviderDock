export function assertAssessmentOutputPath(filePath: string): string;

export function writeExclusiveAssessmentArtifacts(input: {
  readonly snapshotPath: string;
  readonly verificationPath: string;
  readonly snapshotText: string;
  readonly verificationText: string;
}): Promise<void>;
