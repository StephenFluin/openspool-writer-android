import { Component, computed, input, model, output, signal } from '@angular/core';
import { FormValueControl } from '@angular/forms/signals';

export interface ComboOption {
  value: string;
  label?: string;
  /** Secondary text on the right, e.g. "In Spoolman" or "PLA+". */
  hint?: string;
  /** Six-digit hex color shown as a swatch. */
  swatch?: string;
  /** Matches with a lower rank are listed first (default 0). */
  rank?: number;
}

let nextId = 0;

/**
 * Text input with a filterable suggestion list (WAI-ARIA combobox pattern).
 * Anything typed is accepted as-is, so suggestions never block free entry.
 */
@Component({
  selector: 'app-combobox',
  template: `
    <div class="control" [class.invalid]="invalid()">
      @if (swatch()) {
        <span class="swatch" aria-hidden="true" [style.background]="'#' + swatch()"></span>
      }
      <input
        type="text"
        role="combobox"
        autocomplete="off"
        autocapitalize="words"
        spellcheck="false"
        aria-autocomplete="list"
        [id]="inputId()"
        [value]="value()"
        [placeholder]="placeholder()"
        [disabled]="disabled()"
        [attr.aria-expanded]="expanded()"
        [attr.aria-controls]="listboxId"
        [attr.aria-activedescendant]="activeIndex() >= 0 && expanded() ? optionId(activeIndex()) : null"
        [attr.aria-invalid]="invalid() || null"
        [attr.aria-describedby]="describedBy()"
        (input)="onInput($event)"
        (keydown)="onKeydown($event)"
        (click)="openList()"
        (blur)="onBlur()"
      />
      <button
        type="button"
        class="toggle"
        tabindex="-1"
        aria-hidden="true"
        [disabled]="disabled()"
        (mousedown)="$event.preventDefault()"
        (click)="toggleList()"
      >
        <svg viewBox="0 0 24 24" width="20" height="20"><path d="M7 10l5 5 5-5z" fill="currentColor" /></svg>
      </button>
    </div>
    <ul role="listbox" [id]="listboxId" [attr.aria-label]="listLabel()" [hidden]="!expanded()">
      @for (option of filtered(); track option.value + (option.hint ?? '') + $index; let i = $index) {
        <li
          role="option"
          [id]="optionId(i)"
          [class.active]="i === activeIndex()"
          [attr.aria-selected]="i === activeIndex()"
          (mousedown)="$event.preventDefault()"
          (click)="choose(option)"
        >
          @if (option.swatch) {
            <span class="swatch" aria-hidden="true" [style.background]="'#' + option.swatch"></span>
          }
          <span class="label">{{ option.label ?? option.value }}</span>
          @if (option.hint) {
            <span class="hint">{{ option.hint }}</span>
          }
        </li>
      }
    </ul>
  `,
  styleUrl: './combobox.css',
})
export class Combobox implements FormValueControl<string> {
  readonly value = model('');
  readonly disabled = input(false);
  readonly invalid = input(false);
  readonly touch = output<void>();

  readonly inputId = input(`combobox-${nextId++}`);
  readonly options = input<readonly ComboOption[]>([]);
  readonly placeholder = input('');
  readonly listLabel = input('Suggestions');
  readonly describedBy = input<string | null>(null);
  readonly swatch = input<string | null>(null);
  readonly maxResults = input(80);
  /** Emitted when a suggestion (not free text) is chosen. */
  readonly picked = output<ComboOption>();

  protected readonly listboxId = `combobox-list-${nextId++}`;
  protected readonly open = signal(false);
  protected readonly activeIndex = signal(-1);
  /** What the user has typed since opening; empty means "show everything". */
  private readonly query = signal('');

  protected readonly filtered = computed(() => {
    const query = this.query().trim().toLowerCase();
    const options = this.options();
    if (!query) return options.slice(0, this.maxResults());
    const scored: { option: ComboOption; score: number }[] = [];
    for (const option of options) {
      const text = (option.label ?? option.value).toLowerCase();
      const index = text.indexOf(query);
      if (index < 0) continue;
      const wordStart = index === 0 || /[\s\-(/]/.test(text[index - 1]);
      const match = index === 0 ? 0 : wordStart ? 1 : 2;
      scored.push({ option, score: (option.rank ?? 0) * 10 + match });
    }
    return scored
      .sort((a, b) => a.score - b.score)
      .slice(0, this.maxResults())
      .map((s) => s.option);
  });

  protected readonly expanded = computed(() => this.open() && this.filtered().length > 0);

  protected optionId(index: number): string {
    return `${this.listboxId}-${index}`;
  }

  protected onInput(event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.value.set(text);
    this.query.set(text);
    this.activeIndex.set(-1);
    this.open.set(true);
  }

  protected openList(): void {
    if (this.open()) return;
    this.query.set('');
    this.activeIndex.set(-1);
    this.open.set(true);
  }

  protected toggleList(): void {
    if (this.open()) this.open.set(false);
    else this.openList();
  }

  protected onKeydown(event: KeyboardEvent): void {
    const count = this.filtered().length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!this.open()) this.openList();
        else if (count) this.activeIndex.update((i) => (i + 1) % count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (count) this.activeIndex.update((i) => (i <= 0 ? count - 1 : i - 1));
        break;
      case 'Enter':
        if (this.expanded()) {
          event.preventDefault();
          const option = this.filtered()[this.activeIndex()];
          if (option) this.choose(option);
          else this.open.set(false);
        }
        break;
      case 'Escape':
        if (this.expanded()) {
          event.preventDefault();
          this.open.set(false);
        }
        break;
      case 'Tab':
        this.open.set(false);
        break;
    }
  }

  protected onBlur(): void {
    this.open.set(false);
    this.touch.emit();
  }

  protected choose(option: ComboOption): void {
    this.value.set(option.value);
    this.query.set('');
    this.open.set(false);
    this.activeIndex.set(-1);
    this.picked.emit(option);
  }
}
