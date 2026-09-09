import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type FrameLocator,
  type Locator,
  type Page,
} from 'playwright';
import type { ActionSpec, Invocation, Predicate, TargetSpec, ValueRef } from '../contracts/artifact.js';
import { resolveValue } from '../contracts/artifact.js';
import type { Policy } from '../safety/policy.js';
import { assertActionAllowed, assertUrlAllowed } from '../safety/policy.js';
import type { OwnershipToken } from '../runtime/session.js';
import { SessionController } from '../runtime/session.js';
import { TargetResolutionError, type ActionReceipt, type HumanAction, type SurfaceAdapter } from './surface.js';
import { ActionBudget } from '../runtime/action-budget.js';

export type ObservedControl = {
  id: string;
  actionId?: string;
  kind: 'button' | 'link' | 'input' | 'select';
  name: string;
  context: string;
  target: TargetSpec;
  allowedActions: Array<'click' | 'fill' | 'select'>;
  value?: string;
  matchesInput?: string;
  blockedReason?: 'completed' | 'form_incomplete' | 'policy';
};
export type Observation = {
  revision: number;
  url: string;
  path: string;
  title: string;
  text: string;
  controls: ObservedControl[];
};
export type { ActionReceipt } from './surface.js';

export { TargetResolutionError } from './surface.js';

export class PlaywrightSurface implements SurfaceAdapter {
  private constructor(
    private readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
    readonly baseUrl: string,
    readonly policy: Policy,
    readonly session: SessionController,
    readonly frameTitle: string,
  ) {
    this.actionBudget = new ActionBudget(policy.maxActions);
  }
  private revision = 0;
  private observed = new Map<string, { locator: Locator; target: TargetSpec; path: string; revision: number }>();
  private humanActionListener: ((action: HumanAction) => void | Promise<void>) | undefined;
  private readonly actionBudget: ActionBudget;

  get maxActions(): number {
    return this.actionBudget.maximum;
  }
  get actionCount(): number {
    return this.actionBudget.used;
  }

  static async launch(options: {
    baseUrl: string;
    policy: Policy;
    headed?: boolean;
    frameTitle?: string;
  }): Promise<PlaywrightSurface> {
    assertUrlAllowed(options.baseUrl, options.policy);
    const browser = await chromium.launch({ headless: !options.headed });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const session = new SessionController();
    const page = await context.newPage();
    const surface = new PlaywrightSurface(
      browser,
      context,
      page,
      options.baseUrl,
      options.policy,
      session,
      options.frameTitle ?? 'Servicing workspace',
    );
    await context.exposeBinding('__foundryRecordHumanEvent', async (_source, action: HumanAction) => {
      if (surface.session.token().owner === 'human' && surface.humanActionListener)
        await surface.humanActionListener(action);
    });
    await context.route('**/*', async (route) => {
      if (
        route.request().isNavigationRequest() &&
        surface.session.token().owner === 'human' &&
        surface.humanActionListener
      ) {
        const path = new URL(route.request().url()).pathname;
        await surface.humanActionListener({ event: 'click', tag: 'navigation', name: path });
      }
      try {
        assertUrlAllowed(route.request().url(), options.policy);
      } catch {
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    await context.addInitScript(() => {
      const record = (event: Event) => {
        const element = (event.target as Element | null)?.closest('button,a,input,select');
        if (!element) return;
        const name =
          element.getAttribute('aria-label') ?? element.getAttribute('name') ?? element.textContent?.trim() ?? '';
        void (
          window as unknown as { __foundryRecordHumanEvent?: (action: HumanAction) => Promise<void> }
        ).__foundryRecordHumanEvent?.({
          event: event.type as HumanAction['event'],
          tag: element.tagName.toLowerCase(),
          name,
        });
      };
      document.addEventListener('click', record, true);
      document.addEventListener('change', record, true);
    });
    return surface;
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  setHumanActionListener(listener?: (action: HumanAction) => void | Promise<void>): void {
    this.humanActionListener = listener;
  }

  private async assertResolvedActionAllowed(kind: string, locator: Locator): Promise<void> {
    const control = await locator.evaluate((element) => {
      const resolved = element.closest('button,a,input,select') ?? element;
      const name =
        resolved.getAttribute('aria-label') ?? resolved.getAttribute('name') ?? resolved.textContent?.trim() ?? '';
      let destination: string | undefined;
      if (resolved instanceof HTMLAnchorElement) destination = resolved.href;
      if (resolved instanceof HTMLButtonElement || resolved instanceof HTMLInputElement) {
        if ((resolved.getAttribute('type') ?? 'submit').toLowerCase() === 'submit')
          destination = resolved.formAction || resolved.form?.action;
      }
      return { name, destination };
    });
    assertActionAllowed(kind, control.name, this.policy);
    if (kind === 'click' && control.destination) assertUrlAllowed(control.destination, this.policy);
  }

  private workspaceFrame(): Frame {
    return (
      this.page
        .frames()
        .find(
          (frame) =>
            frame !== this.page.mainFrame() &&
            (new URL(frame.url()).pathname.startsWith('/workspace') ||
              new URL(frame.url()).pathname.startsWith('/auth')),
        ) ?? this.page.mainFrame()
    );
  }

  private frameLocator(name: string): Page | FrameLocator {
    return name === 'main' ? this.page : this.page.frameLocator(`iframe[title=${JSON.stringify(this.frameTitle)}]`);
  }

  private async unique(locator: Locator, description: string): Promise<Locator> {
    const visible = locator.filter({ visible: true });
    const count = await visible.count();
    if (count === 0) throw new TargetResolutionError('TARGET_NOT_FOUND', `No visible target matched ${description}`);
    if (count > 1) throw new TargetResolutionError('AMBIGUOUS_TARGET', `${count} targets matched ${description}`);
    return visible;
  }

  private async targetForControl(
    locator: Locator,
    kind: ObservedControl['kind'],
    name: string,
    context: string,
    inputs?: Invocation,
  ): Promise<TargetSpec> {
    const frame = 'workspace';
    if ((kind === 'input' || kind === 'select') && context) {
      const rowLabel = context.trim().split(/\s*[\r\n\t]+\s*/)[0] ?? context.trim();
      return { kind: 'tableRowControl', frame, rowText: rowLabel, control: kind };
    }
    if (kind === 'link' && context) {
      const refs = Object.entries(inputs ?? {})
        .filter(([, value]) => context.includes(String(value)))
        .map(([key]) => ({ kind: 'input' as const, name: key }));
      const rowTexts = refs.length
        ? [...(context.includes('Checking') ? [{ kind: 'constant' as const, value: 'Checking' }] : []), ...refs]
        : [{ kind: 'constant' as const, value: context }];
      return { kind: 'tableRowLink', frame, rowTexts, linkName: name };
    }
    return { kind: 'role', frame, role: kind === 'input' ? 'textbox' : kind, name, exact: true };
  }

  async observe(inputs?: Invocation, displays: Record<string, ValueRef> = {}): Promise<Observation> {
    await this.page.waitForLoadState('domcontentloaded');
    const frame = this.workspaceFrame();
    const observedPath = new URL(frame.url()).pathname;
    this.revision += 1;
    this.observed.clear();
    const candidates = frame.locator('button,a,input:not([type="hidden"]),select');
    const count = await candidates.count();
    const controls: ObservedControl[] = [];
    for (let index = 0; index < count; index += 1) {
      const locator = candidates.nth(index);
      if (!(await locator.isVisible())) continue;
      const tag = await locator.evaluate((element) => element.tagName.toLowerCase());
      const kind = tag === 'a' ? 'link' : (tag as ObservedControl['kind']);
      const ariaLabel = await locator.getAttribute('aria-label');
      const text = (await locator.textContent())?.trim();
      const name = ariaLabel || text || (await locator.getAttribute('name')) || '';
      const contextLocator = locator.locator('xpath=ancestor::tr[1]');
      const context = (await contextLocator.count()) ? await contextLocator.innerText() : '';
      const id = `r${this.revision}-c${index}`;
      const target = await this.targetForControl(locator, kind, name.trim(), context.trim(), inputs);
      const value = kind === 'input' || kind === 'select' ? await locator.inputValue() : undefined;
      const matchesInput =
        value === undefined
          ? undefined
          : Object.entries(inputs ?? {}).find(([inputName, inputValue]) => {
              const display = displays[inputName]
                ? resolveValue(displays[inputName]!, inputs ?? {})
                : String(inputValue);
              return value === display;
            })?.[0];
      let blockedReason: ObservedControl['blockedReason'] = matchesInput ? 'completed' : undefined;
      if (!blockedReason && (kind === 'button' || kind === 'link')) {
        try {
          await this.assertResolvedActionAllowed('click', locator);
        } catch {
          blockedReason = 'policy';
        }
      }
      if (
        !blockedReason &&
        kind === 'button' &&
        ((await locator.getAttribute('type')) ?? 'submit').toLowerCase() === 'submit'
      ) {
        const form = locator.locator('xpath=ancestor::form[1]');
        if (await form.count()) {
          const fields = form.locator(
            'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]),select,textarea',
          );
          for (let fieldIndex = 0; fieldIndex < (await fields.count()); fieldIndex += 1) {
            const field = fields.nth(fieldIndex);
            if ((await field.isEnabled()) && (await field.inputValue()).trim() === '') {
              blockedReason = 'form_incomplete';
              break;
            }
          }
        }
      }
      const allowedActions: Array<'click' | 'fill' | 'select'> = blockedReason
        ? []
        : kind === 'input'
          ? ['fill']
          : kind === 'select'
            ? ['select']
            : ['click'];
      if (allowedActions.length)
        this.observed.set(id, { locator, target, path: observedPath, revision: this.revision });
      controls.push({
        id,
        ...(allowedActions[0] ? { actionId: `${id}:${allowedActions[0]}` } : {}),
        kind,
        name: name.trim(),
        context: context.trim().replace(/\s+/g, ' '),
        target,
        allowedActions,
        ...(value !== undefined ? { value } : {}),
        ...(matchesInput ? { matchesInput } : {}),
        ...(blockedReason ? { blockedReason } : {}),
      });
    }
    const url = frame.url();
    return {
      revision: this.revision,
      url,
      path: new URL(url).pathname,
      title: await frame.title(),
      text: (await frame.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 5000),
      controls,
    };
  }

  async actObserved(
    controlId: string,
    kind: 'click' | 'fill' | 'select',
    value: string | undefined,
    token: OwnershipToken,
  ): Promise<ActionReceipt> {
    this.session.assert(token, 'automation');
    const found = this.observed.get(controlId);
    if (!found) throw new Error('STALE_OR_UNKNOWN_CONTROL');
    const frame = this.workspaceFrame();
    if (new URL(frame.url()).pathname !== found.path) throw new Error('STALE_OBSERVATION_PATH');
    await this.assertResolvedActionAllowed(kind, found.locator);
    this.actionBudget.consume();
    const beforePath = new URL(frame.url()).pathname;
    if (kind === 'click') {
      const navigation = frame
        .waitForURL((url) => url.pathname !== beforePath, { waitUntil: 'domcontentloaded', timeout: 2_000 })
        .catch(() => undefined);
      await found.locator.click();
      await navigation;
    }
    if (kind === 'fill') await found.locator.fill(value ?? '');
    if (kind === 'select') await found.locator.selectOption(value ?? '');
    const activeFrame = this.workspaceFrame();
    await activeFrame.waitForLoadState('domcontentloaded');
    const afterPath = new URL(activeFrame.url()).pathname;
    return { action: kind, target: found.target, beforePath, afterPath };
  }

  async resolve(target: TargetSpec, inputs: Invocation): Promise<Locator> {
    const scope = this.frameLocator(target.frame);
    if (target.kind === 'role')
      return this.unique(
        scope.getByRole(target.role as never, { name: target.name, exact: target.exact }),
        JSON.stringify(target),
      );
    if (target.kind === 'label')
      return this.unique(scope.getByLabel(target.label, { exact: target.exact }), JSON.stringify(target));
    if (target.kind === 'text')
      return this.unique(scope.getByText(target.text, { exact: target.exact }), JSON.stringify(target));
    if (target.kind === 'tableRowControl') {
      const row = scope.locator('tr').filter({ hasText: target.rowText });
      return this.unique(row.locator(target.control), JSON.stringify(target));
    }
    if (target.kind === 'tableRowValue') {
      const row = scope.locator('tr').filter({ has: scope.locator('th', { hasText: target.rowText }) });
      return this.unique(row.locator('td'), JSON.stringify(target));
    }
    let row = scope.locator('tr');
    for (const ref of target.rowTexts) row = row.filter({ hasText: resolveValue(ref, inputs) });
    return this.unique(row.getByRole('link', { name: target.linkName, exact: true }), JSON.stringify(target));
  }

  async act(
    action: ActionSpec,
    targets: Record<string, TargetSpec>,
    inputs: Invocation,
    token: OwnershipToken,
  ): Promise<ActionReceipt> {
    this.session.assert(token, 'automation');
    assertActionAllowed(action.kind, undefined, this.policy);
    const frame = this.workspaceFrame();
    const beforePath = new URL(frame.url()).pathname;
    if (action.kind === 'navigate') {
      const url = new URL(action.path, this.baseUrl).toString();
      assertUrlAllowed(url, this.policy);
      this.actionBudget.consume();
      await this.page.goto(url);
    } else {
      const target = targets[action.target];
      if (!target) throw new Error(`Unknown target ${action.target}`);
      const locator = await this.resolve(target, inputs);
      await this.assertResolvedActionAllowed(action.kind, locator);
      this.actionBudget.consume();
      if (action.kind === 'click') {
        const navigation = frame
          .waitForURL((url) => url.pathname !== beforePath, { waitUntil: 'domcontentloaded', timeout: 2_000 })
          .catch(() => undefined);
        await locator.click();
        await navigation;
      }
      if (action.kind === 'fill') await locator.fill(resolveValue(action.value, inputs));
      if (action.kind === 'select') await locator.selectOption(resolveValue(action.value, inputs));
    }
    const activeFrame = this.workspaceFrame();
    await activeFrame.waitForLoadState('domcontentloaded');
    const afterPath = new URL(activeFrame.url()).pathname;
    assertUrlAllowed(this.workspaceFrame().url(), this.policy);
    return { action: action.kind, beforePath, afterPath };
  }

  async check(predicate: Predicate, targets: Record<string, TargetSpec>, inputs: Invocation): Promise<boolean> {
    if (predicate.kind === 'all')
      return (await Promise.all(predicate.checks.map((check) => this.check(check, targets, inputs)))).every(Boolean);
    if (predicate.kind === 'urlPath') return new URL(this.workspaceFrame().url()).pathname === predicate.path;
    const target = targets[predicate.target];
    if (!target) return false;
    try {
      const locator = await this.resolve(target, inputs);
      if (predicate.kind === 'visible') return locator.isVisible();
      const actual = ['INPUT', 'SELECT'].includes(await locator.evaluate((element) => element.tagName))
        ? await locator.inputValue()
        : (await locator.innerText()).trim();
      return actual === resolveValue(predicate.value, inputs);
    } catch {
      return false;
    }
  }

  async read(target: TargetSpec, inputs: Invocation): Promise<string> {
    const locator = await this.resolve(target, inputs);
    return ['INPUT', 'SELECT'].includes(await locator.evaluate((element) => element.tagName))
      ? locator.inputValue()
      : (await locator.innerText()).trim();
  }

  async sanitizedSnapshot(inputs: Invocation): Promise<unknown> {
    const observation = await this.observe(inputs);
    return {
      revision: observation.revision,
      path: observation.path,
      title: observation.title,
      controls: observation.controls.map(({ kind, name, allowedActions, matchesInput, blockedReason }) => ({
        kind,
        name,
        allowedActions,
        ...(matchesInput ? { matchesInput } : {}),
        ...(blockedReason ? { blockedReason } : {}),
      })),
    };
  }

  async captureFailureScreenshot(path: string): Promise<void> {
    const frame = this.workspaceFrame();
    const mask = frame.locator('input, select, textarea, td, .value');
    await this.page.screenshot({ path, fullPage: true, mask: [mask], maskColor: '#111111' });
  }
}
