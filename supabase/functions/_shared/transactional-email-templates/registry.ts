import ContactFormNotification, {
  subject as contactSubject,
  type ContactFormNotificationProps,
} from "./contact-form-notification.tsx";

export type TemplateMap = {
  "contact-form-notification": ContactFormNotificationProps;
};

export const templates: {
  [K in keyof TemplateMap]: {
    component: (props: TemplateMap[K]) => JSX.Element;
    subject:   (props: TemplateMap[K]) => string;
  };
} = {
  "contact-form-notification": {
    component: ContactFormNotification,
    subject:   contactSubject,
  },
};
