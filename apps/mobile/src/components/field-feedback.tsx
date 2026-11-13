import {
  createContext,
  useContext,
  useImperativeHandle,
  useRef,
  type ComponentRef,
  type ComponentProps,
  type PropsWithChildren,
  type Ref,
} from 'react';
import { View } from 'react-native';
import { HelperText, TextInput } from 'react-native-paper';

export const RevealFieldContext = createContext<
  (view: ComponentRef<typeof View> | null) => void
>(() => {});

/** Keeps the focused form input visible as the keyboard and multiline content resize. */
export function FocusAwareTextInput(props: ComponentProps<typeof TextInput>) {
  const view = useRef<ComponentRef<typeof View>>(null);
  const focused = useRef(false);
  const reveal = useContext(RevealFieldContext);
  return (
    <View
      ref={view}
      collapsable={false}
      onLayout={() => {
        if (focused.current) reveal(view.current);
      }}
    >
      <TextInput
        {...props}
        onFocus={(event) => {
          focused.current = true;
          reveal(view.current);
          props.onFocus?.(event);
        }}
        onBlur={(event) => {
          focused.current = false;
          reveal(null);
          props.onBlur?.(event);
        }}
        onContentSizeChange={(event) => {
          if (focused.current) reveal(view.current);
          props.onContentSizeChange?.(event);
        }}
      />
    </View>
  );
}

/** Connect form error focus to its scroll position, including non-text controls. */
export function FieldFeedback({
  fieldRef,
  message,
  children,
}: PropsWithChildren<{
  fieldRef?: Ref<{ focus(): void }>;
  message?: string;
}>) {
  const view = useRef<ComponentRef<typeof View>>(null);
  const reveal = useContext(RevealFieldContext);
  useImperativeHandle(
    fieldRef,
    () => ({
      focus() {
        requestAnimationFrame(() => {
          if (view.current) reveal(view.current);
        });
      },
    }),
    [reveal],
  );
  return (
    <View ref={view} collapsable={false}>
      {children}
      {!!message && (
        <HelperText type="error" accessibilityRole="alert">
          {message}
        </HelperText>
      )}
    </View>
  );
}
