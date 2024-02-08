import { DeepPartial } from 'utility-types';

import { DEFAULT_SETTINGS } from '@/const/settings';
import { GlobalServerConfig, GlobalSettings } from '@/types/settings';

export interface GlobalSettingsState {
  avatar?: string;
  defaultSettings: GlobalSettings;
  serverConfig: GlobalServerConfig;
  settings: DeepPartial<GlobalSettings>;
}

export const initialSettingsState: GlobalSettingsState = {
  defaultSettings: DEFAULT_SETTINGS,
  serverConfig: {},
  settings: {},
};
