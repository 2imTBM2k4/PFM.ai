import { uuid } from 'expo';
import { useFocusEffect } from 'expo-router';
import type { CategoryInput } from '@pfm/contracts';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { BackHandler, FlatList, Pressable, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  Divider,
  HelperText,
  SegmentedButtons,
  Switch,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import {
  EmptyStateCard,
  IconBadge,
  Screen,
  StatusPill,
  styles,
} from '@/components/screen';
import { AppleMenuPicker } from '@/components/ui';
import { useDesignTheme, useFinancePalette } from '@/constants/theme';
import { withDatabase } from '@/data/connection';
import type { Database } from '@/data/migrate';
import {
  archiveCategory,
  restoreCategory,
  CATEGORY_COLORS,
  CATEGORY_ICONS,
  createCategory,
  listCategories,
  updateCategory,
  type CategoryRow,
} from '@/data/categories';
import { vi } from '@/messages/vi';
import { displayCategoryName } from '@/messages/seed-labels';
import { checkBudgetAlerts } from '@/features/budgets/mobile';
import { useApp } from '@/state/app';

type Mode =
  | { type: 'list' }
  | { type: 'subcategories'; parent: CategoryRow }
  | {
      type: 'form';
      category: CategoryRow | null;
      id: string;
      defaultParentId?: string;
    }
  | { type: 'archive'; category: CategoryRow };

export function CategoryManager({ onClose }: { onClose(): void }) {
  const [rows, setRows] = useState<CategoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [archived, setArchived] = useState(false);
  const [mode, setMode] = useState<Mode>({ type: 'list' });
  const working = useRef(false);
  const { colors } = useTheme();
  const palette = useFinancePalette();

  const back = useCallback(() => {
    if (working.current) return;
    if (mode.type === 'list') {
      onClose();
    } else if (mode.type === 'subcategories') {
      setMode({ type: 'list' });
      setError('');
    } else if (mode.type === 'form') {
      if (mode.defaultParentId) {
        const parent = rows.find((r) => r.id === mode.defaultParentId);
        if (parent) {
          setMode({ type: 'subcategories', parent });
          setError('');
          return;
        }
      }
      setMode({ type: 'list' });
      setError('');
    } else {
      setMode({ type: 'list' });
      setError('');
    }
  }, [mode, onClose, rows]);

  useFocusEffect(
    useCallback(() => {
      const listener = BackHandler.addEventListener('hardwareBackPress', () => {
        back();
        return true;
      });
      return () => listener.remove();
    }, [back]),
  );

  useEffect(() => {
    let cancelled = false;
    withDatabase((db) => listCategories(db, true))
      .then((next) => {
        if (!cancelled) {
          setRows(next);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(vi.categoriesLoadError);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reload = async () => {
    if (working.current) return;
    setLoading(true);
    setError('');
    try {
      setRows(await withDatabase((db) => listCategories(db, true)));
    } catch {
      setError(vi.categoriesLoadError);
    } finally {
      setLoading(false);
    }
  };

  const mutate = async (action: (db: Database) => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setSaved(false);
    let committed = false;
    try {
      const next = await withDatabase(async (db) => {
        await action(db);
        committed = true;
        return listCategories(db, true);
      });
      setRows(next);
      void checkBudgetAlerts();
      void useApp.getState().refreshRecurring(true);
      // If we were editing a subcategory, stay in subcategories view if parent still exists
      if (mode.type === 'form' && mode.defaultParentId) {
        const parent = next.find((r) => r.id === mode.defaultParentId);
        if (parent) {
          setMode({ type: 'subcategories', parent });
          setSaved(true);
          return;
        }
      }
      setMode({ type: 'list' });
      setSaved(true);
    } catch (failure) {
      if (committed) {
        setMode({ type: 'list' });
        setError(vi.walletSavedRefreshFailed);
      } else {
        setError(
          failure instanceof Error && failure.message.startsWith('CATEGORY_')
            ? vi.categoryInvalid
            : vi.saveError,
        );
      }
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const edit = useCallback((category: CategoryRow) => {
    setMode({
      type: 'form',
      category,
      id: category.id,
      defaultParentId: category.parent_id ?? undefined,
    });
    setError('');
    setSaved(false);
  }, []);

  const archive = useCallback((category: CategoryRow) => {
    setMode({ type: 'archive', category });
    setError('');
    setSaved(false);
  }, []);

  const openSubcategories = useCallback((parent: CategoryRow) => {
    setMode({ type: 'subcategories', parent });
    setError('');
    setSaved(false);
  }, []);

  // 1. Subcategory Management Screen
  if (mode.type === 'subcategories') {
    const parent = rows.find((r) => r.id === mode.parent.id) ?? mode.parent;
    const subcategories = rows.filter(
      (row) => row.parent_id === parent.id && !!row.is_archived === archived,
    );

    return (
      <Screen
        title={displayCategoryName(parent.name)}
        subtitle={`${parent.kind === 'expense' ? vi.categoryExpense : vi.categoryIncome} · ${vi.categorySubcategories}`}
        onBack={back}
        backDisabled={busy}
        scroll={false}
        headerRight={
          <Button
            contentStyle={styles.compactButton}
            mode="contained"
            icon="plus"
            disabled={loading || busy}
            onPress={() => {
              setMode({
                type: 'form',
                category: null,
                id: uuid.v4(),
                defaultParentId: parent.id,
              });
              setError('');
              setSaved(false);
            }}
          >
            {vi.addSubcategory}
          </Button>
        }
      >
        <SegmentedButtons
          value={archived ? 'archived' : 'active'}
          onValueChange={(value) => setArchived(value === 'archived')}
          buttons={[
            { value: 'active', label: vi.walletActive, disabled: busy },
            { value: 'archived', label: vi.walletArchived, disabled: busy },
          ]}
        />

        {saved && (
          <View
            style={[
              styles.subtlePanel,
              {
                backgroundColor: palette.incomeSoft,
                borderColor: palette.income,
              },
            ]}
          >
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: palette.incomeInk, fontWeight: '600' }}
            >
              {vi.categorySaved}
            </Text>
          </View>
        )}

        {!!error && (
          <View
            style={[
              styles.subtlePanel,
              {
                backgroundColor: palette.dangerSoft,
                borderColor: palette.danger,
              },
            ]}
          >
            <Text accessibilityRole="alert" style={{ color: colors.error }}>
              {error}
            </Text>
            <Button disabled={loading} onPress={reload}>
              {vi.retry}
            </Button>
          </View>
        )}

        <FlatList
          style={styles.fill}
          showsVerticalScrollIndicator={false}
          data={subcategories}
          keyExtractor={(row) => row.id}
          renderItem={({ item }) => (
            <CategoryItem
              category={item}
              parentName={displayCategoryName(parent.name)}
              onEdit={edit}
              onArchive={archive}
              busy={busy}
              onRestore={(category) =>
                void mutate((db) =>
                  restoreCategory(db, category.id, new Date().toISOString()),
                )
              }
            />
          )}
          contentContainerStyle={{ gap: 12, paddingBottom: 24 }}
          contentInsetAdjustmentBehavior="automatic"
          ListEmptyComponent={
            <EmptyStateCard
              icon="tag-multiple-outline"
              message={vi.noSubcategories}
            />
          }
        />
      </Screen>
    );
  }

  // 2. Add / Edit Category Form
  if (mode.type === 'form') {
    return (
      <CategoryForm
        category={mode.category}
        defaultParentId={mode.defaultParentId}
        rows={rows}
        busy={busy}
        error={error}
        onBack={back}
        onSave={(input) =>
          mutate((db) =>
            mode.category
              ? updateCategory(db, mode.id, input, new Date().toISOString())
              : createCategory(db, mode.id, input, new Date().toISOString()),
          )
        }
      />
    );
  }

  // 3. Archive Form
  if (mode.type === 'archive') {
    return (
      <ArchiveForm
        category={mode.category}
        rows={rows}
        busy={busy}
        error={error}
        onBack={back}
        onSave={(replacement) =>
          mutate((db) =>
            archiveCategory(
              db,
              mode.category.id,
              replacement,
              new Date().toISOString(),
            ),
          )
        }
      />
    );
  }

  // 4. Main Category Screen: ONLY Parent Categories with Subcategory Counts
  const parentCategories = rows.filter(
    (row) => !row.parent_id && !!row.is_archived === archived,
  );

  return (
    <Screen
      title={vi.manageCategories}
      subtitle={vi.parentCategoriesTitle}
      onBack={back}
      backDisabled={busy}
      scroll={false}
      headerRight={
        <Button
          contentStyle={styles.compactButton}
          mode="contained"
          icon="plus"
          disabled={loading || busy}
          onPress={() => {
            setMode({ type: 'form', category: null, id: uuid.v4() });
            setError('');
            setSaved(false);
          }}
        >
          {vi.addCategory}
        </Button>
      }
    >
      <SegmentedButtons
        value={archived ? 'archived' : 'active'}
        onValueChange={(value) => setArchived(value === 'archived')}
        buttons={[
          { value: 'active', label: vi.walletActive, disabled: busy },
          { value: 'archived', label: vi.walletArchived, disabled: busy },
        ]}
      />

      {archived && (
        <Text variant="bodySmall" style={{ color: palette.textMuted }}>
          {vi.restoreCategoryHint}
        </Text>
      )}

      {saved && (
        <View
          style={[
            styles.subtlePanel,
            {
              backgroundColor: palette.incomeSoft,
              borderColor: palette.income,
            },
          ]}
        >
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: palette.incomeInk, fontWeight: '600' }}
          >
            {vi.categorySaved}
          </Text>
        </View>
      )}

      {!!error && (
        <View
          style={[
            styles.subtlePanel,
            {
              backgroundColor: palette.dangerSoft,
              borderColor: palette.danger,
            },
          ]}
        >
          <Text accessibilityRole="alert" style={{ color: colors.error }}>
            {error}
          </Text>
          <Button disabled={loading} onPress={reload}>
            {vi.retry}
          </Button>
        </View>
      )}

      {loading ? (
        <View style={{ paddingVertical: 28, alignItems: 'center' }}>
          <ActivityIndicator size="large" accessibilityLabel={vi.loading} />
        </View>
      ) : (
        <FlatList
          style={styles.fill}
          showsVerticalScrollIndicator={false}
          data={parentCategories}
          keyExtractor={(row) => row.id}
          renderItem={({ item }) => {
            const subCount = rows.filter(
              (r) => r.parent_id === item.id && !r.is_archived,
            ).length;

            return (
              <ParentCategoryCard
                category={item}
                subCount={subCount}
                onSelect={() => openSubcategories(item)}
                onEdit={() => edit(item)}
                onArchive={() => archive(item)}
                onRestore={() =>
                  void mutate((db) =>
                    restoreCategory(db, item.id, new Date().toISOString()),
                  )
                }
                busy={busy}
              />
            );
          }}
          contentContainerStyle={{ gap: 12, paddingBottom: 24 }}
          contentInsetAdjustmentBehavior="automatic"
          ListEmptyComponent={
            <EmptyStateCard icon="shape-outline" message={vi.categoriesEmpty} />
          }
        />
      )}
    </Screen>
  );
}

/**
 * Parent Category Card displaying icon, category name, subcategory count, and navigation chevron
 */
const ParentCategoryCard = memo(function ParentCategoryCard({
  category,
  subCount,
  onSelect,
  onEdit,
  onArchive,
  onRestore,
  busy,
}: {
  category: CategoryRow;
  subCount: number;
  onSelect(): void;
  onEdit(): void;
  onArchive(): void;
  onRestore(): void;
  busy: boolean;
}) {
  const palette = useFinancePalette();
  const theme = useDesignTheme();
  const isExpense = category.kind === 'expense';

  return (
    <View
      style={[
        styles.panel,
        {
          backgroundColor: palette.surface,
          borderColor: palette.border,
          padding: 16,
          gap: 12,
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${displayCategoryName(category.name)}, ${subCount} ${vi.subcategoriesCount}`}
        onPress={onSelect}
        style={({ pressed }) => [
          styles.row,
          { alignItems: 'center' },
          pressed && { opacity: 0.7 },
        ]}
      >
        <View style={[styles.inlineRow, { flex: 1, gap: 12 }]}>
          <IconBadge
            icon={category.icon ?? 'tag-outline'}
            bg={isExpense ? palette.expenseSoft : palette.incomeSoft}
            fg={
              category.color ??
              (isExpense ? palette.expenseInk : palette.incomeInk)
            }
            size={42}
            iconSize={22}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="titleMedium" style={{ fontWeight: '700' }}>
              {displayCategoryName(category.name)}
            </Text>
            <Text variant="bodySmall" style={{ color: palette.textMuted }}>
              {isExpense ? vi.categoryExpense : vi.categoryIncome}
            </Text>
          </View>
        </View>

        {/* Subcategories count badge & chevron */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <StatusPill
            label={`${subCount} ${vi.subcategoriesCount}`}
            bg={palette.purpleSoft}
            fg={palette.purpleInk}
          />
          <MaterialCommunityIcons
            name="chevron-right"
            size={22}
            color={theme.text.muted}
          />
        </View>
      </Pressable>

      <Divider style={{ backgroundColor: palette.borderSubtle }} />

      {category.is_archived ? (
        <Button
          mode="contained-tonal"
          icon="restore"
          disabled={busy}
          contentStyle={styles.button}
          onPress={onRestore}
        >
          {vi.restoreCategory}
        </Button>
      ) : (
        <View
          style={[
            styles.row,
            { justifyContent: 'space-between', alignItems: 'center' },
          ]}
        >
          <Button
            compact
            mode="text"
            icon="format-list-bulleted"
            disabled={busy}
            onPress={onSelect}
          >
            {vi.categorySubcategories} ({subCount})
          </Button>

          <View style={{ flexDirection: 'row', gap: 4 }}>
            <Button
              compact
              mode="contained-tonal"
              icon="pencil-outline"
              disabled={busy}
              onPress={onEdit}
            >
              {vi.editCategory}
            </Button>
            <Button
              compact
              mode="text"
              icon="archive-arrow-down-outline"
              disabled={busy}
              onPress={onArchive}
            >
              {vi.archiveCategory}
            </Button>
          </View>
        </View>
      )}
    </View>
  );
});

/**
 * Subcategory Item Component
 */
const CategoryItem = memo(function CategoryItem({
  category,
  parentName,
  onEdit,
  onArchive,
  onRestore,
  busy,
}: {
  category: CategoryRow;
  parentName?: string;
  onEdit(category: CategoryRow): void;
  onArchive(category: CategoryRow): void;
  onRestore(category: CategoryRow): void;
  busy: boolean;
}) {
  const palette = useFinancePalette();
  const isExpense = category.kind === 'expense';

  return (
    <View
      style={[
        styles.panel,
        {
          backgroundColor: palette.surface,
          borderColor: palette.border,
          padding: 16,
          gap: 10,
        },
      ]}
    >
      <View style={styles.row}>
        <View style={[styles.inlineRow, { flex: 1, gap: 12 }]}>
          <IconBadge
            icon={category.icon ?? 'tag-outline'}
            bg={isExpense ? palette.expenseSoft : palette.incomeSoft}
            fg={
              category.color ??
              (isExpense ? palette.expenseInk : palette.incomeInk)
            }
            size={38}
            iconSize={20}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="titleMedium" style={{ fontWeight: '700' }}>
              {displayCategoryName(category.name)}
            </Text>
            <Text variant="bodySmall" style={{ color: palette.textMuted }}>
              {isExpense ? vi.categoryExpense : vi.categoryIncome}
              {parentName ? ` · ${parentName}` : ''}
            </Text>
          </View>
        </View>
        {!!category.is_fixed_cost && (
          <StatusPill
            label={vi.categoryFixed}
            bg={palette.primarySoft}
            fg={palette.primaryInk}
          />
        )}
      </View>

      <Divider style={{ backgroundColor: palette.borderSubtle }} />

      {category.is_archived ? (
        <Button
          mode="contained-tonal"
          icon="restore"
          disabled={busy}
          contentStyle={styles.button}
          onPress={() => onRestore(category)}
        >
          {vi.restoreCategory}
        </Button>
      ) : (
        <View style={[styles.row, { justifyContent: 'flex-end' }]}>
          <Button
            compact
            mode="contained-tonal"
            icon="pencil-outline"
            disabled={busy}
            onPress={() => onEdit(category)}
          >
            {vi.editCategory}
          </Button>
          <Button
            compact
            mode="text"
            icon="archive-arrow-down-outline"
            disabled={busy}
            onPress={() => onArchive(category)}
          >
            {vi.archiveCategory}
          </Button>
        </View>
      )}
    </View>
  );
});

interface Fields {
  name: string;
  kind: CategoryRow['kind'];
  parentId: string;
  isFixedCost: boolean;
  icon: string;
  color: string;
}

/**
 * Category Form using Apple-style menus for category kind, parent category, icon, and color
 */
function CategoryForm({
  category,
  defaultParentId,
  rows,
  busy,
  error,
  onBack,
  onSave,
}: {
  category: CategoryRow | null;
  defaultParentId?: string;
  rows: CategoryRow[];
  busy: boolean;
  error: string;
  onBack(): void;
  onSave(input: CategoryInput): Promise<void>;
}) {
  const defaultParent = defaultParentId
    ? rows.find((r) => r.id === defaultParentId)
    : null;

  const {
    control,
    setValue,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<Fields>({
    defaultValues: {
      name: category?.name ?? '',
      kind: category?.kind ?? defaultParent?.kind ?? 'expense',
      parentId: category?.parent_id ?? defaultParentId ?? '',
      isFixedCost: !!category?.is_fixed_cost,
      icon: category?.icon ?? '',
      color: category?.color ?? '',
    },
  });

  const kind = useWatch({ control, name: 'kind' });
  const disabled = busy || isSubmitting;
  const { colors } = useTheme();
  const palette = useFinancePalette();

  const icons = useMemo(
    () => [
      vi.categoryIconTag,
      vi.categoryIconFood,
      vi.categoryIconHome,
      vi.categoryIconCar,
      vi.categoryIconCart,
      vi.categoryIconCash,
    ],
    [],
  );
  const colorNames = useMemo(
    () => [
      vi.categoryColorBlue,
      vi.categoryColorGreen,
      vi.categoryColorOrange,
      vi.categoryColorPurple,
    ],
    [],
  );

  const categoryKindOptions = useMemo(
    () => [
      {
        value: 'expense' as const,
        label: vi.categoryExpense,
        icon: 'arrow-down-circle',
        iconBg: palette.expenseSoft,
        iconColor: palette.expenseInk,
      },
      {
        value: 'income' as const,
        label: vi.categoryIncome,
        icon: 'arrow-up-circle',
        iconBg: palette.incomeSoft,
        iconColor: palette.incomeInk,
      },
    ],
    [palette],
  );

  const parentOptions = useMemo(
    () => [
      {
        value: '',
        label: vi.categoryNoParent,
        icon: 'folder-outline',
        iconBg: palette.surfaceMuted,
        iconColor: palette.textMuted,
      },
      ...rows
        .filter(
          (row) =>
            !row.is_archived &&
            !row.parent_id &&
            row.kind === kind &&
            row.id !== category?.id,
        )
        .map((row) => ({
          value: row.id,
          label: row.name,
          icon: row.icon || 'folder-outline',
          iconBg:
            row.kind === 'expense' ? palette.expenseSoft : palette.incomeSoft,
          iconColor:
            row.color ||
            (row.kind === 'expense' ? palette.expenseInk : palette.incomeInk),
        })),
    ],
    [rows, kind, category?.id, palette],
  );

  const iconOptions = useMemo(
    () => [
      {
        value: '',
        label: vi.categoryDefault,
        icon: 'tag-outline',
        iconBg: palette.surfaceMuted,
        iconColor: palette.textMuted,
      },
      ...CATEGORY_ICONS.map((icon, index) => ({
        value: icon,
        label: icons[index] ?? icon,
        icon: icon,
        iconBg: palette.primarySoft,
        iconColor: palette.primaryInk,
      })),
    ],
    [icons, palette],
  );

  const colorOptions = useMemo(
    () => [
      {
        value: '',
        label: vi.categoryDefault,
        colorSwatch: palette.primary,
      },
      ...CATEGORY_COLORS.map((color, index) => ({
        value: color,
        label: colorNames[index] ?? color,
        colorSwatch: color,
      })),
    ],
    [colorNames, palette],
  );

  return (
    <Screen
      title={category ? vi.editCategory : vi.addCategory}
      subtitle={vi.categoryStructureHint}
      onBack={onBack}
      backDisabled={disabled}
    >
      <View
        style={[
          styles.panel,
          {
            backgroundColor: palette.surface,
            borderColor: palette.border,
            gap: 12,
          },
        ]}
      >
        <Controller
          control={control}
          name="name"
          rules={{
            validate: (value) => !!value.trim() || vi.categoryNameRequired,
          }}
          render={({ field, fieldState }) => (
            <View>
              <TextInput
                mode="outlined"
                label={vi.categoryName}
                accessibilityLabel={vi.categoryName}
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                disabled={disabled}
                error={!!fieldState.error}
                left={<TextInput.Icon icon="shape-outline" />}
              />
              {!!fieldState.error && (
                <HelperText type="error">{fieldState.error.message}</HelperText>
              )}
            </View>
          )}
        />

        <Divider style={{ backgroundColor: palette.borderSubtle }} />

        {/* Apple-style Category Kind Selector */}
        <Controller
          control={control}
          name="kind"
          render={({ field }) => (
            <AppleMenuPicker
              label={vi.categoryKind}
              value={field.value}
              options={categoryKindOptions}
              disabled={disabled || !!category}
              onSelect={(value) => {
                field.onChange(value);
                setValue('parentId', '');
              }}
            />
          )}
        />

        <Divider style={{ backgroundColor: palette.borderSubtle }} />

        {/* Apple-style Parent Category Selector */}
        <Controller
          control={control}
          name="parentId"
          render={({ field }) => (
            <AppleMenuPicker
              label={vi.categoryParent}
              value={field.value}
              options={parentOptions}
              disabled={disabled || !!category}
              onSelect={field.onChange}
            />
          )}
        />

        <Divider style={{ backgroundColor: palette.borderSubtle }} />

        <Controller
          control={control}
          name="isFixedCost"
          render={({ field }) => (
            <View style={styles.row}>
              <Text style={{ flex: 1, fontWeight: '500' }}>
                {vi.categoryFixed}
              </Text>
              <Switch
                value={field.value}
                onValueChange={field.onChange}
                accessibilityLabel={vi.categoryFixed}
                disabled={disabled}
              />
            </View>
          )}
        />
      </View>

      {/* Visual Identity: Icon & Color (Apple-style Dropdowns) */}
      <View
        style={[
          styles.panel,
          {
            backgroundColor: palette.surface,
            borderColor: palette.border,
            gap: 12,
          },
        ]}
      >
        <Controller
          control={control}
          name="icon"
          render={({ field }) => (
            <AppleMenuPicker
              label={vi.categoryIcon}
              value={field.value}
              options={iconOptions}
              disabled={disabled}
              onSelect={field.onChange}
            />
          )}
        />

        <Divider style={{ backgroundColor: palette.borderSubtle }} />

        <Controller
          control={control}
          name="color"
          render={({ field }) => (
            <AppleMenuPicker
              label={vi.categoryColor}
              value={field.value}
              options={colorOptions}
              disabled={disabled}
              onSelect={field.onChange}
            />
          )}
        />
      </View>

      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      )}

      <Button
        mode="contained"
        icon="check"
        contentStyle={styles.button}
        disabled={disabled}
        loading={disabled}
        onPress={() => {
          void handleSubmit((values) =>
            onSave({
              ...values,
              parentId: values.parentId || null,
              icon: values.icon || null,
              color: values.color || null,
            }),
          )();
        }}
      >
        {vi.saveCategory}
      </Button>
    </Screen>
  );
}

function ArchiveForm({
  category,
  rows,
  busy,
  error,
  onBack,
  onSave,
}: {
  category: CategoryRow;
  rows: CategoryRow[];
  busy: boolean;
  error: string;
  onBack(): void;
  onSave(replacement: string | null): Promise<void>;
}) {
  const [replacement, setReplacement] = useState('');
  const { colors } = useTheme();
  const palette = useFinancePalette();

  const targets = rows.filter(
    (row) =>
      !row.is_archived &&
      row.kind === category.kind &&
      row.id !== category.id &&
      row.parent_id !== category.id,
  );

  const replacementOptions = useMemo(
    () => [
      {
        value: '',
        label: vi.categoryKeepHistory,
        icon: 'history',
        iconBg: palette.surfaceMuted,
        iconColor: palette.textMuted,
      },
      ...targets.map((row) => ({
        value: row.id,
        label: row.name,
        subtitle: row.parent_id
          ? `${displayCategoryName(rows.find((parent) => parent.id === row.parent_id)?.name)} › ${displayCategoryName(row.name)}`
          : undefined,
        icon: row.icon || 'tag-outline',
        iconBg:
          row.kind === 'expense' ? palette.expenseSoft : palette.incomeSoft,
        iconColor:
          row.color ||
          (row.kind === 'expense' ? palette.expenseInk : palette.incomeInk),
      })),
    ],
    [targets, rows, palette],
  );

  return (
    <Screen title={vi.archiveCategory} onBack={onBack} backDisabled={busy}>
      <View
        style={[
          styles.panel,
          { backgroundColor: palette.surface, borderColor: palette.border },
        ]}
      >
        <Text variant="titleLarge" style={{ fontWeight: '700' }}>
          {displayCategoryName(category.name)}
        </Text>
        <Text style={{ color: palette.textMuted, lineHeight: 20 }}>
          {vi.categoryArchiveDescription}
        </Text>
      </View>

      <View
        style={[
          styles.panel,
          {
            backgroundColor: palette.surface,
            borderColor: palette.border,
            gap: 12,
          },
        ]}
      >
        <Text
          accessibilityRole="header"
          variant="titleSmall"
          style={{ fontWeight: '700' }}
        >
          {vi.categoryReassign}
        </Text>
        <Text variant="bodySmall" style={{ color: palette.textMuted }}>
          {vi.categoryMoveHistory}
        </Text>

        <AppleMenuPicker
          label={vi.categoryReassign}
          value={replacement}
          options={replacementOptions}
          disabled={busy}
          onSelect={(val) => setReplacement(String(val))}
        />
      </View>

      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      )}

      <Button
        mode="contained"
        icon="archive-arrow-down-outline"
        contentStyle={styles.button}
        disabled={busy}
        loading={busy}
        onPress={() => {
          void onSave(replacement || null);
        }}
      >
        {vi.archiveCategory}
      </Button>
    </Screen>
  );
}
