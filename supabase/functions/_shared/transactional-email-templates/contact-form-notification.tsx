import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
  Hr,
} from "npm:@react-email/components@0.0.22";
import * as React from "npm:react@18.3.1";

export interface ContactFormNotificationProps {
  name: string;
  email: string;
  message: string;
}

export const subject = ({ name }: ContactFormNotificationProps) =>
  `New TableFinder contact form submission from ${name}`;

export default function ContactFormNotification({
  name,
  email,
  message,
}: ContactFormNotificationProps) {
  return (
    <Html>
      <Head>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Outfit:wght@400;500&display=swap');
        `}</style>
      </Head>
      <Preview>New contact form submission from {name}</Preview>
      <Body style={body}>
        <Container style={container}>
          {/* Header */}
          <Section style={header}>
            <Heading style={heading}>TableFinder</Heading>
            <Text style={subheading}>New Contact Form Submission</Text>
          </Section>

          {/* Content */}
          <Section style={content}>
            <Text style={label}>FROM</Text>
            <Text style={value}>{name}</Text>

            <Text style={label}>REPLY TO</Text>
            <Text style={value}>{email}</Text>

            <Hr style={divider} />

            <Text style={label}>MESSAGE</Text>
            <Text style={messageText}>{message}</Text>
          </Section>

          {/* Footer */}
          <Section style={footer}>
            <Text style={footerText}>
              Sent via the contact form at tablefinder.ai
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const body: React.CSSProperties = {
  backgroundColor: "#ffffff",
  fontFamily: "'Outfit', Arial, sans-serif",
  margin: 0,
  padding: 0,
};

const container: React.CSSProperties = {
  maxWidth: "560px",
  margin: "0 auto",
  backgroundColor: "#ffffff",
};

const header: React.CSSProperties = {
  backgroundColor: "#1a1a1a",
  padding: "32px 40px 24px",
  borderRadius: "8px 8px 0 0",
};

const heading: React.CSSProperties = {
  fontFamily: "'Playfair Display', Georgia, serif",
  fontSize: "28px",
  fontWeight: 700,
  color: "#c9a96e",
  margin: "0 0 4px 0",
  letterSpacing: "-0.5px",
};

const subheading: React.CSSProperties = {
  fontFamily: "'Outfit', Arial, sans-serif",
  fontSize: "13px",
  color: "#9ca3af",
  margin: 0,
  letterSpacing: "0.05em",
  textTransform: "uppercase" as const,
};

const content: React.CSSProperties = {
  padding: "32px 40px",
  backgroundColor: "#fafafa",
  border: "1px solid #e5e7eb",
  borderTop: "none",
};

const label: React.CSSProperties = {
  fontFamily: "'Outfit', Arial, sans-serif",
  fontSize: "11px",
  fontWeight: 500,
  color: "#9ca3af",
  letterSpacing: "0.1em",
  textTransform: "uppercase" as const,
  margin: "0 0 4px 0",
};

const value: React.CSSProperties = {
  fontFamily: "'Outfit', Arial, sans-serif",
  fontSize: "15px",
  color: "#111827",
  margin: "0 0 20px 0",
};

const divider: React.CSSProperties = {
  borderColor: "#e5e7eb",
  margin: "8px 0 20px",
};

const messageText: React.CSSProperties = {
  fontFamily: "'Outfit', Arial, sans-serif",
  fontSize: "15px",
  color: "#374151",
  lineHeight: "1.6",
  margin: 0,
  whiteSpace: "pre-wrap" as const,
};

const footer: React.CSSProperties = {
  padding: "16px 40px 24px",
  backgroundColor: "#ffffff",
  border: "1px solid #e5e7eb",
  borderTop: "none",
  borderRadius: "0 0 8px 8px",
};

const footerText: React.CSSProperties = {
  fontFamily: "'Outfit', Arial, sans-serif",
  fontSize: "12px",
  color: "#9ca3af",
  margin: 0,
  textAlign: "center" as const,
};
