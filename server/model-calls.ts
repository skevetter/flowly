import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SummaryModelError } from "./summary-models";
import type { SummarySettings } from "../shared/summary";

export class ModelCallBlocked extends SummaryModelError {
  override name = "ModelCallBlocked";
}

export type ModelCallClaim = () => Promise<void>;
export const modelCallsDenied: ModelCallClaim = async () => {
  throw new ModelCallBlocked("Sending text to models is not set up.");
};

type ModelCallLimits = Pick<SummarySettings, "sendTextToModels" | "dailyCallLimit">;

const counterSchema = z.object({ day: z.string(), count: z.number().int().min(0) });
type Counter = z.infer<typeof counterSchema>;

/** `model-calls.json`: model runs started today. Claims are serialized; the file is replaced atomically. */
export class ModelCallLedger {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly directory: string,
    private now: () => Date = () => new Date(),
  ) {}

  private get path() {
    return join(this.directory, "model-calls.json");
  }

  claim(limits: ModelCallLimits): Promise<void> {
    const run = this.tail.then(() => this.count(limits));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async count({ sendTextToModels, dailyCallLimit }: ModelCallLimits) {
    if (!sendTextToModels) throw new ModelCallBlocked("Sending text to models is off. Turn it on in Settings → AI features.");
    const day = this.now().toISOString().slice(0, 10);
    const stored = await this.read();
    const count = stored?.day === day ? stored.count : 0;
    if (count >= dailyCallLimit) throw new ModelCallBlocked(`The daily limit of ${dailyCallLimit} model runs is reached.`);
    await this.write({ day, count: count + 1 });
  }

  private async read(): Promise<Counter | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return counterSchema.parse(JSON.parse(text));
    } catch {
      await copyFile(this.path, join(this.directory, `model-calls.invalid-${this.now().toISOString().replace(/[:.]/g, "-")}.json`));
      return null;
    }
  }

  private async write(counter: Counter) {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(counter));
    await rename(temporary, this.path);
  }
}
