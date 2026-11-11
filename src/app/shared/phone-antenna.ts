import { Component, computed, resource } from '@angular/core';
import { AntennaSpot, loadAntennaSpot } from '../core/nfc/antenna';

/** A 25 mm sticker, drawn to scale on the phone. */
const TAG_RADIUS = 12.5;
const MARGIN = 14;

/** The back of the phone, to scale, with a tag on the spot where its NFC antenna is. */
@Component({
  selector: 'app-phone-antenna',
  template: `
    @if (spot(); as s) {
      <figure>
        <svg
          aria-hidden="true"
          [attr.viewBox]="-margin + ' ' + -margin + ' ' + (s.width + margin * 2) + ' ' + (s.height + margin * 2)"
        >
          <rect class="body" [attr.width]="s.width" [attr.height]="s.height" rx="9" />
          <circle class="wave" [attr.cx]="s.x" [attr.cy]="s.y" [attr.r]="tagRadius" />
          <circle class="wave late" [attr.cx]="s.x" [attr.cy]="s.y" [attr.r]="tagRadius" />
          <circle class="tag" [attr.cx]="s.x" [attr.cy]="s.y" [attr.r]="tagRadius" />
        </svg>
        <figcaption>{{ caption() }}</figcaption>
      </figure>
    }
  `,
  styles: `
    figure {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
      margin: 0 0 0.75rem;
    }
    svg {
      height: 170px;
      overflow: visible;
    }
    .body {
      fill: var(--surface-alt);
      stroke: var(--text-muted);
      stroke-width: 1.5;
    }
    .tag {
      fill: var(--accent);
      fill-opacity: 0.85;
    }
    .wave {
      fill: none;
      stroke: var(--accent);
      stroke-width: 1.5;
      transform-box: fill-box;
      transform-origin: center;
      animation: pulse 2s ease-out infinite;
    }
    .late {
      animation-delay: 1s;
    }
    figcaption {
      max-width: 22rem;
      text-align: center;
    }
    @keyframes pulse {
      0% {
        transform: scale(1);
        opacity: 0.8;
      }
      100% {
        transform: scale(2.2);
        opacity: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .wave {
        animation: none;
        opacity: 0;
      }
    }
  `,
})
export class PhoneAntenna {
  private readonly loaded = resource({ loader: () => loadAntennaSpot() });

  protected readonly margin = MARGIN;
  protected readonly tagRadius = TAG_RADIUS;
  protected readonly spot = computed<AntennaSpot | undefined>(() => (this.loaded.hasValue() ? this.loaded.value() : undefined));
  protected readonly caption = computed(() => {
    const spot = this.spot();
    if (!spot) return '';
    if (spot.platform === 'ios') return 'Touch the tag to the top edge of your iPhone and hold it there.';
    if (spot.source === 'device') {
      return `Hold the tag flat on the back of your phone, over the marked spot (${placement(spot)}). That’s where your phone says its NFC antenna is.`;
    }
    return 'Hold the tag flat against the back of your phone, near the middle. The exact spot varies, so move it slowly if nothing happens.';
  });
}

/** "upper middle", "lower left"… as seen from the back. */
function placement(spot: AntennaSpot): string {
  const vertical = spot.y < spot.height / 3 ? 'upper' : spot.y > (spot.height * 2) / 3 ? 'lower' : 'middle';
  const horizontal = spot.x < spot.width / 3 ? 'left' : spot.x > (spot.width * 2) / 3 ? 'right' : 'middle';
  return vertical === 'middle' && horizontal === 'middle' ? 'the middle' : `${vertical} ${horizontal}`;
}
