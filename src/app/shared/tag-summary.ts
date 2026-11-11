import { Component, input } from '@angular/core';
import { TagInfo } from '../core/nfc/nfc-types';

/** Compact facts about a physical tag: chip, UID, capacity, lock state. */
@Component({
  selector: 'app-tag-summary',
  template: `
    <dl>
      @if (tag().kind) {
        <div><dt>Chip</dt><dd>{{ tag().kind }}</dd></div>
      }
      <div>
        <dt>UID</dt>
        <dd class="mono">{{ tag().uid || 'Not reported' }}</dd>
      </div>
      @if (tag().capacity) {
        <div><dt>Space</dt><dd>{{ tag().capacity }} bytes</dd></div>
      }
      @if (tag().writable !== null) {
        <div><dt>Locked</dt><dd>{{ tag().writable ? 'No' : 'Yes' }}</dd></div>
      }
    </dl>
  `,
  styles: `
    dl {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 1.25rem;
      margin: 0.75rem 0;
      font-size: 0.875rem;
    }
    div {
      display: flex;
      gap: 0.375rem;
    }
    dt {
      color: var(--text-muted);
    }
    dd {
      margin: 0;
    }
    .mono {
      font-family: var(--mono);
    }
  `,
})
export class TagSummary {
  readonly tag = input.required<TagInfo>();
}
