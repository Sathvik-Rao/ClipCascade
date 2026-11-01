package com.acme.clipcascade.service;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.FontFormatException;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.Shape;
import java.awt.geom.AffineTransform;
import java.awt.geom.QuadCurve2D;
import java.awt.geom.Path2D;
import java.awt.geom.PathIterator;
import java.awt.geom.Rectangle2D;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.InputStream;
import java.security.SecureRandom;
import java.util.Locale;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import com.acme.clipcascade.config.ClipCascadeProperties;

import cn.apiclub.captcha.Captcha;
import cn.apiclub.captcha.backgrounds.FlatColorBackgroundProducer;
import jakarta.servlet.http.HttpSession;

@Service
public class CaptchaService {
    // Avoid easily confused characters (0/O, 1/I/L) and use keyboard ASCII only.
    private static final String CHARACTERS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    private static final Color INK = new Color(24, 40, 64);
    private final SecureRandom random = new SecureRandom();
    private final Font font;
    private final int difficultyPercent;

    public CaptchaService(@Autowired ClipCascadeProperties properties) {
        difficultyPercent = properties.getCaptchaDifficultyPercent();
        font = properties.isSignupEnabled() ? loadFont() : null;
    }

    private static Font loadFont() {
        // Never fall back to host fonts: symbol fonts and missing fonts made the
        // same difficulty look completely different on different installations.
        try (InputStream source = CaptchaService.class.getResourceAsStream("/captcha/RobotoMono.ttf")) {
            if (source == null) {
                throw new IllegalStateException("Bundled CAPTCHA font is missing");
            }
            Font result = Font.createFont(Font.TRUETYPE_FONT, source).deriveFont(Font.BOLD, 40f);
            if (result.canDisplayUpTo(CHARACTERS) != -1) {
                throw new IllegalStateException("Bundled CAPTCHA font does not support the character set");
            }
            return result;
        } catch (IOException | FontFormatException e) {
            throw new IllegalStateException("Unable to load bundled CAPTCHA font", e);
        }
    }

    public BufferedImage generateCaptcha(int width, int height, int minSizeOfCaptcha, int maxSizeOfCaptcha,
            HttpSession session, String captchaSessionId, boolean caseSensitive) {
        if (minSizeOfCaptcha < 1 || maxSizeOfCaptcha < minSizeOfCaptcha) {
            throw new IllegalArgumentException("Invalid CAPTCHA length range");
        }
        Captcha captcha = createCaptcha(width, height,
                random.nextInt(maxSizeOfCaptcha - minSizeOfCaptcha + 1) + minSizeOfCaptcha);
        session.setAttribute(captchaSessionId,
                caseSensitive ? captcha.getAnswer() : captcha.getAnswer().toLowerCase(Locale.ROOT));
        return getCaptchaImage(captcha);
    }

    public boolean validateCaptcha(String input, boolean caseSensitive, HttpSession session, String captchaSessionId) {
        String answer = (String) session.getAttribute(captchaSessionId);
        session.removeAttribute(captchaSessionId);
        if (input == null || answer == null) {
            return false;
        }
        return answer.equals(caseSensitive ? input : input.toLowerCase(Locale.ROOT));
    }

    public Captcha createCaptcha(int width, int height, int sizeOfCaptcha) {
        return createCaptcha(width, height, sizeOfCaptcha, difficultyPercent);
    }

    /**
     * Difficulty controls rotation, shear, glyph warping, speckles and crossing curves.
     * Zero has plain, evenly spaced text. Higher values increase those effects
     * without changing contrast, fonts, character count or available glyph space.
     * Answers and effect positions remain random; difficulty is a visual setting.
     */
    public Captcha createCaptcha(int width, int height, int sizeOfCaptcha, int difficultyPercent) {
        if (font == null) {
            throw new IllegalStateException("CAPTCHA generation requires signup to be enabled");
        }
        if (sizeOfCaptcha < 1 || height < 24 || width < 12L * sizeOfCaptcha + 16) {
            throw new IllegalArgumentException("CAPTCHA dimensions must allow space for every character");
        }
        int difficulty = Math.max(0, Math.min(100, difficultyPercent));
        return new Captcha.Builder(width, height)
                .addBackground(new FlatColorBackgroundProducer(Color.WHITE))
                .addText(() -> randomAnswer(sizeOfCaptcha),
                        (answer, image) -> render(answer, image, difficulty))
                .addBorder()
                .build();
    }

    private String randomAnswer(int length) {
        StringBuilder answer = new StringBuilder(length);
        for (int i = 0; i < length; i++) {
            answer.append(CHARACTERS.charAt(random.nextInt(CHARACTERS.length())));
        }
        return answer.toString();
    }

    private void render(String answer, BufferedImage image, int difficulty) {
        Graphics2D graphics = image.createGraphics();
        try {
            graphics.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            graphics.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
            double strength = difficulty / 100.0;
            // Background clutter grows quadratically so low settings stay readable.
            graphics.setColor(new Color(190, 203, 219));
            graphics.setStroke(new BasicStroke((float) (0.5 + strength)));
            for (int i = 0; i < difficulty / 25; i++) {
                graphics.draw(new QuadCurve2D.Double(1, random.nextInt(image.getHeight()),
                        image.getWidth() / 2.0, random.nextInt(image.getHeight()),
                        image.getWidth() - 2, random.nextInt(image.getHeight())));
            }
            for (int i = 0; i < (int) (image.getWidth() * image.getHeight() * 0.04 * strength * strength); i++) {
                graphics.fillOval(1 + random.nextInt(image.getWidth() - 2),
                        1 + random.nextInt(image.getHeight() - 2), 1, 1);
            }
            graphics.setColor(INK);
            double cellWidth = (image.getWidth() - 16.0) / answer.length();
            double maxHeight = image.getHeight() - 16.0;
            for (int i = 0; i < answer.length(); i++) {
                Shape glyph = font.createGlyphVector(graphics.getFontRenderContext(),
                        answer.substring(i, i + 1)).getOutline();
                double deformation = strength * strength;
                glyph = warp(glyph, deformation);
                AffineTransform distortion = new AffineTransform();
                // At maximum difficulty every glyph gets a substantial tilt.
                double angle = Math.toRadians((18 + random.nextDouble() * 14) * strength
                        * (random.nextBoolean() ? 1 : -1));
                distortion.rotate(angle);
                distortion.shear((random.nextDouble() * 2 - 1) * 0.35 * deformation, 0);
                glyph = distortion.createTransformedShape(glyph);
                Rectangle2D bounds = glyph.getBounds2D();
                double scale = Math.min(1, Math.min((cellWidth - 6) / bounds.getWidth(),
                        maxHeight / bounds.getHeight()));
                double jitter = (random.nextDouble() * 2 - 1) * 3 * strength;
                AffineTransform placement = new AffineTransform();
                placement.translate(8 + (i + 0.5) * cellWidth, image.getHeight() / 2.0 + jitter);
                placement.scale(scale, scale);
                placement.translate(-bounds.getCenterX(), -bounds.getCenterY());
                graphics.fill(placement.createTransformedShape(glyph));
            }
            // Strong settings also cross the letters with thin, contrasting
            // strokes. Keep these lighter than the glyphs so no answer vanishes.
            graphics.setColor(new Color(90, 105, 125));
            graphics.setStroke(new BasicStroke((float) (0.6 + strength * 0.6)));
            int crossingLines = Math.max(0, (difficulty - 40) / 15);
            for (int i = 0; i < crossingLines; i++) {
                double y = image.getHeight() * (0.25 + 0.5 * (i + 0.5) / crossingLines);
                double bend = (random.nextBoolean() ? 1 : -1) * image.getHeight() * 0.45;
                graphics.draw(new QuadCurve2D.Double(2, y, image.getWidth() / 2.0, y + bend,
                        image.getWidth() - 3, y));
            }
        } finally {
            graphics.dispose();
        }
    }

    private Shape warp(Shape glyph, double strength) {
        if (strength == 0) {
            return glyph;
        }
        // Warp the vector outline before fitting it into its character cell,
        // preserving all strokes and keeping distortion independent of host fonts.
        PathIterator outline = glyph.getPathIterator(null, 0.25);
        Path2D warped = new Path2D.Double(outline.getWindingRule());
        double phase = random.nextDouble() * Math.PI * 2;
        double[] point = new double[6];
        while (!outline.isDone()) {
            int segment = outline.currentSegment(point);
            double x = point[0] + 3.5 * strength * Math.sin(point[1] / 6 + phase);
            double y = point[1] + 2.5 * strength * Math.sin(point[0] / 7 + phase);
            if (segment == PathIterator.SEG_MOVETO) {
                warped.moveTo(x, y);
            } else if (segment == PathIterator.SEG_LINETO) {
                warped.lineTo(x, y);
            } else if (segment == PathIterator.SEG_CLOSE) {
                warped.closePath();
            }
            outline.next();
        }
        return warped;
    }

    public BufferedImage getCaptchaImage(Captcha captcha) {
        return captcha.getImage();
    }
}
