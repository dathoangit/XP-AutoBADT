import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'XP-AutoBADT',
  description:
    'Export HIS/EMR CLS results to merged PDF from an Excel list of maHoSo.',
  version: '1.0.0',
  action: {
    default_title: 'XP-AutoBADT',
    default_icon: {
      '16': 'public/icons/icon-16.png',
      '32': 'public/icons/icon-32.png',
      '48': 'public/icons/icon-48.png',
      '128': 'public/icons/icon-128.png'
    }
  },
  icons: {
    '16': 'public/icons/icon-16.png',
    '32': 'public/icons/icon-32.png',
    '48': 'public/icons/icon-48.png',
    '128': 'public/icons/icon-128.png'
  },
  background: {
    service_worker: 'src/background.ts',
    type: 'module'
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html'
  },
  permissions: [
    'storage',
    'downloads',
    'tabs',
    'scripting',
    'debugger',
    'sidePanel'
  ],
  host_permissions: [
    'http://172.16.16.17:2301/*',
    'http://172.16.16.17:2382/*',
    'http://172.16.16.17:2201/*',
    'https://script.google.com/*',
    'https://script.googleusercontent.com/*'
  ],
  content_scripts: [
    {
      matches: ['http://172.16.16.17:2382/*'],
      js: ['src/content/auth-reader.ts'],
      run_at: 'document_idle'
    }
  ]
});
