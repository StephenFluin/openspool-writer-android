import { Component } from '@angular/core';

@Component({
  selector: 'app-help-page',
  templateUrl: './help-page.html',
  styles: `
    h3 {
      margin: 1.25rem 0 0.25rem;
      font-size: 1rem;
    }
    li + li {
      margin-top: 0.375rem;
    }
    code {
      font-family: var(--mono);
      font-size: 0.875em;
    }
  `,
})
export class HelpPage {}
