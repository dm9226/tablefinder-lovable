import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { SiteFooter } from "@/components/SiteFooter";

const Contact = () => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const addr = ["contact", "@", "tablefinder", ".ai"].join("");
    const subject = encodeURIComponent("TableFinder Contact Form");
    const body = encodeURIComponent(
      `Name: ${name}\nEmail: ${email}\n\nMessage:\n${message}`
    );
    window.location.href = `mailto:${addr}?subject=${subject}&body=${body}`;
    setSubmitted(true);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Helmet>
        <title>Contact — TableFinder</title>
        <meta name="description" content="Get in touch with TableFinder." />
        <link rel="canonical" href="https://tablefinder.ai/contact" />
      </Helmet>

      <header className="pt-6 pb-3 px-4 text-center">
        <Link to="/" className="inline-block">
          <h1 className="font-heading text-3xl md:text-4xl font-bold text-foreground tracking-tight">
            Table<span className="text-primary">Finder</span>
          </h1>
        </Link>
      </header>

      <main className="flex-1 max-w-2xl mx-auto px-4 py-10 w-full">
        <h2 className="font-heading text-3xl md:text-4xl font-bold text-foreground mb-2">
          Contact
        </h2>
        <p className="text-muted-foreground font-body text-sm mb-8">
          We aim to respond within 1–2 business days.
        </p>

        {submitted ? (
          <div className="p-6 rounded-lg bg-card border border-border text-center">
            <p className="font-heading text-lg font-semibold text-foreground mb-1">Thank you!</p>
            <p className="text-muted-foreground font-body text-sm">Your message has been sent. We'll be in touch soon.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 rounded-lg bg-card border border-border space-y-5">
            <div className="space-y-1.5">
              <label className="text-sm font-body font-medium text-foreground" htmlFor="contact-name">
                Name
              </label>
              <input
                id="contact-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-background border border-border text-foreground font-body text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="Your name"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-body font-medium text-foreground" htmlFor="contact-email">
                Email
              </label>
              <input
                id="contact-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-background border border-border text-foreground font-body text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="you@example.com"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-body font-medium text-foreground" htmlFor="contact-message">
                Message
              </label>
              <textarea
                id="contact-message"
                required
                rows={5}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-background border border-border text-foreground font-body text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                placeholder="How can we help?"
              />
            </div>

            <button
              type="submit"
              className="w-full py-2 px-4 rounded-md bg-primary text-primary-foreground font-body font-semibold text-sm hover:bg-primary/90 transition-colors"
            >
              Send Message
            </button>
          </form>
        )}
      </main>

      <SiteFooter />
    </div>
  );
};

export default Contact;
