import {
  MUTATION_CHANNELS,
  legacyMutation,
  weightedMutation,
  validMutationPolicy,
  sameMutationPolicy,
  type MutationPolicy,
} from './mutation';
const labels = {
  add: 'Add a cell',
  remove: 'Remove a cell',
  change: 'Change a cell type',
  preference: 'Temperature preference',
  tolerance: 'Temperature tolerance',
  tempo: 'Movement tempo',
  reactions: 'Active eye reactions',
};
export function mutationControlsMarkup(): string {
  return `<details id="mutation-controls"><summary>Mutation channels</summary><p id="mutation-rules" class="muted">Legacy preserves ordinary bundled mutation. Weighted chooses one channel after the global Mutation rate succeeds. Whole weights 0–100 are relative: zero excludes a channel. Active eye reactions apply only to active designs. With no eligible weight, offspring are clones. Failed anatomy attempts have no fallback.</p><fieldset id="mutation-fields" aria-describedby="mutation-rules"><legend>Birth mutation policy</legend><label for="mutation-mode">Policy</label><select id="mutation-mode"><option value="legacy">Legacy (default)</option><option value="weighted">Weighted channels (opt-in)</option></select><div class="mutation-weights">${MUTATION_CHANNELS.map((key) => `<label for="mutation-weight-${key}">${labels[key]}<input id="mutation-weight-${key}" type="number" min="0" max="100" step="1" required value="1" disabled></label>`).join('')}</div><button id="mutation-apply" type="button">Apply mutation policy</button></fieldset><p id="mutation-status" role="status">Confirmed policy: Legacy.</p></details>`;
}
export function mountMutationControls(root: HTMLElement, apply: (policy: MutationPolicy) => void) {
  const get = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!,
    mode = get<HTMLSelectElement>('mutation-mode'),
    fields = get<HTMLFieldSetElement>('mutation-fields'),
    status = get('mutation-status'),
    button = get('mutation-apply');
  const inputs = MUTATION_CHANNELS.map((key) => get<HTMLInputElement>(`mutation-weight-${key}`));
  let confirmed = legacyMutation(),
    replacement = -1,
    busy = false;
  function draft(): MutationPolicy | null {
    if (mode.value !== 'legacy' && mode.value !== 'weighted') return null;
    const policy = mode.value === 'legacy' ? legacyMutation() : weightedMutation();
    if (policy.mode === 'weighted')
      for (const [i, key] of MUTATION_CHANNELS.entries())
        policy.weights[key] = inputs[i].valueAsNumber;
    return validMutationPolicy(policy) ? policy : null;
  }
  function render() {
    for (const input of inputs) {
      const disabled = mode.value !== 'weighted';
      if (input.disabled !== disabled) input.disabled = disabled;
    }
    const candidate = draft();
    const message = busy
      ? 'Waiting for worker confirmation.'
      : !candidate
        ? 'Use whole weights from 0 to 100.'
        : sameMutationPolicy(candidate, confirmed)
          ? `Confirmed policy: ${confirmed.mode === 'legacy' ? 'Legacy' : 'Weighted channels'}.`
          : 'Draft policy — Apply to change future births.';
    if (status.textContent !== message) status.textContent = message;
  }
  const changed = () => render();
  const submit = () => {
    const policy = draft();
    if (!policy) {
      render();
      return;
    }
    apply(policy);
  };
  mode.addEventListener('change', changed);
  for (const input of inputs) input.addEventListener('input', changed);
  button.addEventListener('click', submit);
  return {
    update(policy: MutationPolicy, replacementId: number) {
      if (replacement === replacementId && sameMutationPolicy(confirmed, policy)) return;
      confirmed = structuredClone(policy);
      replacement = replacementId;
      mode.value = policy.mode;
      const weights = policy.mode === 'weighted' ? policy.weights : weightedMutation().weights;
      for (const [i, key] of MUTATION_CHANNELS.entries()) inputs[i].value = String(weights[key]);
      render();
    },
    setBusy(value: boolean) {
      if (busy === value) return;
      busy = value;
      fields.disabled = value;
      render();
    },
    dispose() {
      mode.removeEventListener('change', changed);
      for (const input of inputs) input.removeEventListener('input', changed);
      button.removeEventListener('click', submit);
    },
  };
}
