import { FileVideo } from "lucide-react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MetadataRow } from "./MetadataRow";

describe("MetadataRow", () => {
  it("marks key and secondary metadata without table cells", () => {
    const { container } = render(<MetadataRow label="源视频" icon={<FileVideo aria-hidden="true" />} items={[
      { key: "resolution", content: "2560 × 1600", priority: "key" },
      { key: "codec", content: "H.264" },
      { key: "empty", content: null },
    ]} />);
    expect(screen.getByText("源视频")).toHaveClass("metadata-label");
    expect(screen.getByText("2560 × 1600")).toHaveClass("priority-key");
    expect(screen.getByText("H.264")).toHaveClass("priority-secondary");
    expect(container.querySelectorAll(".metadata-item")).toHaveLength(2);
    expect(container.querySelector("table")).not.toBeInTheDocument();
  });
});
