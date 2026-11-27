import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Switch, Text, TextInput } from 'react-native-paper';
import { IconBadge, Screen, styles } from '@/components/screen';
import { GlassCard, Pill } from '@/components/ui';
import { useResponsiveLayout } from '@/constants/responsive-layout';
import {
  DesignSpacing,
  useDesignTheme,
  useFinancePalette,
} from '@/constants/theme';
import { useFocusedBackHandler } from '@/hooks/use-focused-back-handler';
import { vi } from '@/messages/vi';
import { getProxyBaseUrl } from '@/services/ai-service';
import {
  BYOK_PROVIDER_PRESETS,
  clearByokConfig,
  DEFAULT_BYOK_CONFIG,
  readByokConfig,
  saveByokConfig,
  testByokConnection,
  type ByokPresetId,
} from './byok-storage';

/** Web-only settings view allowing users to configure their own OpenAI-compatible AI provider. */
export function ByokSettingsView({ onClose }: { onClose(): void }) {
  const theme = useDesignTheme();
  const palette = useFinancePalette();
  const { isWebDesktop } = useResponsiveLayout();

  const initial = readByokConfig();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [preset, setPreset] = useState<ByokPresetId>(initial.preset);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [model, setModel] = useState(initial.model);
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);

  useFocusedBackHandler(() => {
    onClose();
    return true;
  });

  const handleSelectPreset = (nextPreset: ByokPresetId) => {
    setPreset(nextPreset);
    setStatusMessage(null);
    const found = BYOK_PROVIDER_PRESETS.find((item) => item.id === nextPreset);
    if (found && nextPreset !== 'custom') {
      setBaseUrl(found.baseUrl);
      setModel(found.defaultModel);
    }
  };

  const handleSave = () => {
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedModel = model.trim();
    const trimmedKey = apiKey.trim();
    if (enabled && (!trimmedBaseUrl || !trimmedModel || !trimmedKey)) {
      setStatusMessage({ tone: 'error', text: vi.byokMissingFields });
      return;
    }
    if (enabled && !trimmedBaseUrl.startsWith('https://')) {
      setStatusMessage({ tone: 'error', text: vi.byokHttpsRequired });
      return;
    }
    saveByokConfig({
      enabled,
      preset,
      baseUrl: trimmedBaseUrl,
      model: trimmedModel,
      apiKey: trimmedKey,
    });
    setStatusMessage({ tone: 'success', text: vi.byokSavedNotice });
  };

  const handleTest = async () => {
    if (testing) return;
    setTesting(true);
    setStatusMessage(null);
    try {
      const result = await testByokConnection(
        { baseUrl, apiKey, model },
        getProxyBaseUrl(),
      );
      if (result.ok) {
        setStatusMessage({
          tone: 'success',
          text: vi.byokTestSuccess.replace('{model}', result.model),
        });
      } else {
        setStatusMessage({ tone: 'error', text: result.message });
      }
    } finally {
      setTesting(false);
    }
  };

  const handleClear = () => {
    clearByokConfig();
    setEnabled(DEFAULT_BYOK_CONFIG.enabled);
    setPreset(DEFAULT_BYOK_CONFIG.preset);
    setBaseUrl(DEFAULT_BYOK_CONFIG.baseUrl);
    setModel(DEFAULT_BYOK_CONFIG.model);
    setApiKey('');
    setStatusMessage({ tone: 'success', text: vi.byokClearedNotice });
  };

  return (
    <Screen
      title={vi.byokMenuTitle}
      onBack={onClose}
      maxWidth={isWebDesktop ? 760 : undefined}
    >
      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.lg}
        style={{ gap: 14 }}
      >
        <View style={styles.inlineRow}>
          <IconBadge
            icon="key-chain-variant"
            bg={theme.brand.primarySoft}
            fg={theme.brand.primaryStrong}
            size={40}
            iconSize={21}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Text
              variant="titleSmall"
              style={{ fontWeight: '800', color: theme.text.primary }}
            >
              {vi.byokEnableTitle}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.text.secondary }}>
              {vi.byokEnableSubtitle}
            </Text>
          </View>
          <Switch
            accessibilityLabel={vi.byokEnableTitle}
            value={enabled}
            onValueChange={(next) => {
              setEnabled(next);
              setStatusMessage(null);
            }}
          />
        </View>

        <View style={{ gap: 8 }}>
          <Text
            variant="labelLarge"
            style={{ color: theme.text.secondary, fontWeight: '700' }}
          >
            {vi.byokPresetLabel}
          </Text>
          <View style={localStyles.presetRow}>
            {BYOK_PROVIDER_PRESETS.map((item) => (
              <Pill
                key={item.id}
                label={item.label}
                tone="primary"
                selected={preset === item.id}
                size="sm"
                onPress={() => handleSelectPreset(item.id)}
              />
            ))}
          </View>
        </View>

        <TextInput
          mode="outlined"
          label={vi.byokBaseUrlLabel}
          placeholder="https://api.openai.com/v1"
          value={baseUrl}
          onChangeText={(value) => {
            setBaseUrl(value);
            setStatusMessage(null);
          }}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <TextInput
          mode="outlined"
          label={vi.byokModelLabel}
          placeholder="gpt-4o-mini"
          value={model}
          onChangeText={(value) => {
            setModel(value);
            setStatusMessage(null);
          }}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <TextInput
          mode="outlined"
          label={vi.byokApiKeyLabel}
          placeholder="sk-..."
          value={apiKey}
          onChangeText={(value) => {
            setApiKey(value);
            setStatusMessage(null);
          }}
          secureTextEntry={!showKey}
          autoCapitalize="none"
          autoCorrect={false}
          right={
            <TextInput.Icon
              icon={showKey ? 'eye-off-outline' : 'eye-outline'}
              onPress={() => setShowKey((prev) => !prev)}
            />
          }
        />

        {!!statusMessage && (
          <Text
            accessibilityRole="alert"
            variant="bodySmall"
            style={{
              color:
                statusMessage.tone === 'success'
                  ? palette.income
                  : palette.danger,
              fontWeight: '600',
            }}
          >
            {statusMessage.text}
          </Text>
        )}

        <View style={localStyles.actionsRow}>
          <Button
            mode="contained"
            icon="content-save-outline"
            buttonColor={theme.brand.primaryStrong}
            textColor="#FFFFFF"
            onPress={handleSave}
          >
            {vi.byokSaveButton}
          </Button>
          <Button
            mode="outlined"
            icon="connection"
            loading={testing}
            disabled={testing}
            onPress={() => void handleTest()}
          >
            {vi.byokTestButton}
          </Button>
          <Button
            mode="text"
            textColor={palette.danger}
            disabled={testing}
            onPress={handleClear}
          >
            {vi.byokClearButton}
          </Button>
        </View>
      </GlassCard>

      <GlassCard
        variant="elevated"
        radius="xl"
        padding={DesignSpacing.lg}
        style={{ gap: 8 }}
      >
        <Text
          variant="titleSmall"
          style={{ fontWeight: '800', color: theme.text.primary }}
        >
          {vi.byokPrivacyTitle}
        </Text>
        <Text
          variant="bodySmall"
          style={{ color: theme.text.secondary, lineHeight: 20 }}
        >
          {vi.byokPrivacyBody}
        </Text>
      </GlassCard>
    </Screen>
  );
}

const localStyles = StyleSheet.create({
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingTop: 4,
  },
});
