export interface Fixture {
  id: string;
  file: string;
  statements: { startMs: number; endMs: number }[];
  notes: string;
}
export function generate(outDir?: string): {
  manifest: { fixtures: Fixture[] };
  outDir: string;
};
