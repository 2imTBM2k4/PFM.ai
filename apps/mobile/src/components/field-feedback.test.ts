import { expect, it, vi } from 'vitest';
import { FocusAwareTextInput } from './field-feedback';

const { reveal, view } = vi.hoisted(() => ({ reveal: vi.fn(), view: {} }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useContext: () => reveal,
  useRef: () => ({ current: view }),
}));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-native-paper', () => ({
  TextInput: 'TextInput',
  HelperText: 'HelperText',
}));

it('reveals notes on focus and growth while preserving form callbacks and refs', () => {
  const onFocus = vi.fn(),
    onBlur = vi.fn(),
    onContentSizeChange = vi.fn();
  const ref = { current: null };
  const tree = FocusAwareTextInput({
    value: 'note',
    ref,
    onFocus,
    onBlur,
    onContentSizeChange,
  });
  const input = tree.props.children;
  expect(input.props.ref).toBe(ref);
  input.props.onFocus({});
  expect(reveal).toHaveBeenLastCalledWith(view);
  expect(onFocus).toHaveBeenCalledOnce();
  input.props.onContentSizeChange({});
  expect(reveal).toHaveBeenLastCalledWith(view);
  expect(onContentSizeChange).toHaveBeenCalledOnce();
  input.props.onBlur({});
  expect(reveal).toHaveBeenLastCalledWith(null);
  expect(onBlur).toHaveBeenCalledOnce();
  const calls = reveal.mock.calls.length;
  input.props.onContentSizeChange({});
  expect(reveal).toHaveBeenCalledTimes(calls);
});
