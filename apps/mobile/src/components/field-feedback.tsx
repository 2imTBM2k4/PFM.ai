import {
  createContext,
  useContext,
  useImperativeHandle,
  useRef,
  type ComponentRef,
  type PropsWithChildren,
  type Ref,
} from 'react';
import { View } from 'react-native';
import { HelperText } from 'react-native-paper';

export const RevealFieldContext = createContext<
  (view: ComponentRef<typeof View>) => void
>(() => {});

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
