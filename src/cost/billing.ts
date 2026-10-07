import { ZERO_USAGE, type StructuredMode, type Usage } from "../types.js";

export type BillableComponent = {
  readonly provider: string;
  readonly model: string;
  readonly usage: Usage;
  readonly attempts: number;
  readonly providerCost?: number;
};

const metadata = new WeakMap<object, readonly BillableComponent[]>();
const routes = new WeakMap<object, StreamRoute>();
const structured = new WeakMap<object, StructuredBillingDetails>();

export type StreamRoute = {
  readonly provider: string;
  readonly model: string;
  readonly failedOver: boolean;
};

export type StructuredBillingDetails = {
  readonly mode: StructuredMode;
  readonly repairAttempts: number;
};

export function billable(target: object): readonly BillableComponent[] {
  return metadata.get(target) ?? [];
}

export function setBillable<T extends object>(
  target: T,
  components: readonly BillableComponent[],
): T {
  metadata.set(target, Object.freeze([...components]));
  return target;
}

export function copyBillable<T extends object>(source: object, target: T): T {
  const components = billable(source);
  if (components.length > 0) setBillable(target, components);
  return target;
}

export function setStreamRoute<T extends object>(target: T, route: StreamRoute): T {
  routes.set(target, route);
  return target;
}

export function streamRoute(target: object): StreamRoute | undefined {
  return routes.get(target);
}

export function setStructuredBilling<T extends object>(
  target: T,
  details: StructuredBillingDetails,
): T {
  structured.set(target, details);
  return target;
}

export function structuredBilling(
  target: object,
): StructuredBillingDetails | undefined {
  return structured.get(target);
}

export function component(
  provider: string,
  qualifiedModel: string,
  usage: Usage,
  attempts = 1,
  providerCost?: number,
): BillableComponent {
  return {
    provider,
    model: unqualifiedModel(qualifiedModel),
    usage,
    attempts,
    ...(providerCost === undefined ? {} : { providerCost }),
  };
}

export function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheCreationInputTokens:
      left.cacheCreationInputTokens + right.cacheCreationInputTokens,
  };
}

export function sumUsage(components: readonly BillableComponent[]): Usage {
  return components.reduce<Usage>(
    (total, item) => addUsage(total, item.usage),
    ZERO_USAGE,
  );
}

export function sumAttempts(components: readonly BillableComponent[]): number {
  return components.reduce((total, item) => total + item.attempts, 0);
}

export function hasUsage(usage: Usage): boolean {
  return Object.values(usage).some((tokens) => tokens !== 0);
}

function unqualifiedModel(model: string): string {
  return model.includes(":") ? model.slice(model.indexOf(":") + 1) : model;
}
