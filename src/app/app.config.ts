import { provideHttpClient, withFetch } from '@angular/common/http';
import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { SettingsService } from './core/settings.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    // In the native app CapacitorHttp patches fetch, so requests to a LAN Spoolman skip CORS.
    provideHttpClient(withFetch()),
    provideAppInitializer(() => inject(SettingsService).load()),
  ],
};
