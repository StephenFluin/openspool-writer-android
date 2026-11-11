import { Component, computed, input } from '@angular/core';
import { TagInfo } from '../core/nfc/nfc-types';

/** What the chip itself reports (native apps), plus the raw details useful when a tag misbehaves. */
@Component({
  selector: 'app-tag-diagnostics',
  template: `
    @if (tag().chip; as chip) {
      <div class="chip">
        <h3>What the chip reports</h3>
        <ul class="findings">
          @for (finding of chip.findings; track finding) {
            <li>{{ finding }}</li>
          }
        </ul>
        <dl>
          <div><dt>Identifies as</dt><dd>{{ chip.chip }}</dd></div>
          <div><dt>NDEF formatted</dt><dd>{{ yesNo(chip.ndefFormatted) }}</dd></div>
          <div><dt>Lock bits set</dt><dd>{{ yesNo(chip.locked) }}</dd></div>
          <div><dt>Password</dt><dd>{{ yesNo(chip.passwordProtected) }}</dd></div>
        </dl>
      </div>
    }
    <details>
      <summary>Technical details</summary>
      <dl class="raw">
        @if (tag().chip; as chip) {
          <div><dt>GET_VERSION</dt><dd class="mono">{{ chip.version ?? 'No answer' }}</dd></div>
          <div><dt>Page 3</dt><dd class="mono">{{ chip.capabilityContainer ?? 'Unreadable' }}</dd></div>
        } @else {
          <div><dt>Chip</dt><dd>Not inspected (raw commands aren’t available here)</dd></div>
        }
        @if (tag().techTypes.length) {
          <div><dt>Technologies</dt><dd class="mono">{{ techList() }}</dd></div>
        }
        @if (detail(); as detail) {
          <div><dt>Phone said</dt><dd>{{ detail }}</dd></div>
        }
      </dl>
    </details>
  `,
  styles: `
    :host {
      display: block;
      margin: 0.75rem 0;
      text-align: start;
      font-size: 0.875rem;
    }
    h3 {
      margin: 0 0 0.375rem;
      font-size: 1rem;
    }
    .findings {
      margin: 0 0 0.5rem;
      padding-inline-start: 1.25rem;
    }
    dl {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 1.25rem;
      margin: 0;
    }
    dl div {
      display: flex;
      gap: 0.375rem;
    }
    dt {
      color: var(--text-muted);
    }
    dd {
      margin: 0;
    }
    .raw {
      flex-direction: column;
      margin-top: 0.5rem;
    }
    .mono {
      font-family: var(--mono);
      overflow-wrap: anywhere;
    }
    summary {
      cursor: pointer;
      color: var(--text-muted);
      min-height: 44px;
      display: flex;
      align-items: center;
    }
  `,
})
export class TagDiagnostics {
  readonly tag = input.required<TagInfo>();
  /** The error a write or read ended with, if any; its underlying cause is shown verbatim. */
  readonly error = input<unknown>(null);

  protected readonly techList = computed(() =>
    this.tag()
      .techTypes.map((tech) => tech.replace(/^android\.nfc\.tech\./, ''))
      .join(', '),
  );
  protected readonly detail = computed(() => {
    const cause = (this.error() as { cause?: unknown } | null)?.cause;
    return cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : null;
  });

  protected yesNo(value: boolean | null): string {
    return value === null ? 'Unknown' : value ? 'Yes' : 'No';
  }
}
