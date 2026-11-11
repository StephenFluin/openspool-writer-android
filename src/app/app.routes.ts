import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    title: 'Write a tag · U1 Spool Tags',
    loadComponent: () => import('./features/write/write-page').then((m) => m.WritePage),
  },
  {
    path: 'check',
    title: 'Check a tag · U1 Spool Tags',
    loadComponent: () => import('./features/check/check-page').then((m) => m.CheckPage),
  },
  {
    path: 'settings',
    title: 'Settings · U1 Spool Tags',
    loadComponent: () => import('./features/settings/settings-page').then((m) => m.SettingsPage),
  },
  {
    path: 'help',
    title: 'Help · U1 Spool Tags',
    loadComponent: () => import('./features/help/help-page').then((m) => m.HelpPage),
  },
  { path: '**', redirectTo: '' },
];
